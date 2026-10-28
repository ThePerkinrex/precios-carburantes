//! The stations a user saved (with an optional nickname) or hid everywhere.
//! Both lists are private: they only ever list or change the caller's own.

use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    routing::{get, put},
};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::{DbPool, api::format_fecha, auth::ClientAuth, enroll::now, error::AppError};

const MAX_NICKNAME_LEN: usize = 60;

#[derive(Serialize, Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
enum Kind {
    Saved,
    Hidden,
}

impl Kind {
    fn as_str(self) -> &'static str {
        match self {
            Kind::Saved => "saved",
            Kind::Hidden => "hidden",
        }
    }
}

/// A saved or hidden station, with the same station fields as `/api/prices`. Prices are null
/// when the station is no longer in the Ministry's list (`en_listado` false).
#[derive(Serialize)]
struct MyStation {
    kind: String,
    nickname: Option<String>,
    created_at: i64,
    id: i64,
    rotulo: Option<String>,
    horario: Option<String>,
    direccion: Option<String>,
    margen: Option<String>,
    municipio: Option<String>,
    localidad: Option<String>,
    provincia: Option<String>,
    cp: Option<String>,
    latitud: f64,
    longitud: f64,
    ultimo_cambio: String,
    gasoleo_a: Option<f64>,
    gasolina_95: Option<f64>,
    en_listado: bool,
    /// When the station left the list, if it did.
    ultima_vez: Option<String>,
    /// The brand the station had when it was saved, if it has changed since, and when.
    rotulo_anterior: Option<String>,
    rotulo_desde: Option<String>,
}

async fn list(
    State(pool): State<DbPool>,
    auth: ClientAuth,
) -> Result<Json<Vec<MyStation>>, AppError> {
    let conn = pool.get()?;
    let rows = conn
        .prepare(
            r#"
            SELECT
                u.kind, u.nickname, u.created_at,
                e.id, e.rotulo, e.horario, e.direccion, e.margen, e.municipio, e.localidad,
                e.provincia, e.cp, e.latitud, e.longitud,
                (SELECT MAX(q.fecha) FROM precios q WHERE q.id_estacion = e.id AND q.reportado = 1),
                p.gasoleo_a, p.gasolina_95, p.id_estacion IS NOT NULL,
                (SELECT MAX(q.fecha) FROM precios q WHERE q.id_estacion = e.id AND q.reportado = 0),
                -- The brand last seen before it was saved, and when the current one first was.
                (SELECT r.rotulo FROM estaciones_rotulos r
                    WHERE r.id_estacion = e.id AND r.first_seen <= u.created_at
                    ORDER BY r.last_seen DESC LIMIT 1),
                (SELECT r.first_seen FROM estaciones_rotulos r
                    WHERE r.id_estacion = e.id AND r.rotulo = e.rotulo)
            FROM user_stations u
            JOIN estaciones e ON e.id = u.station_id
            LEFT JOIN precios_actuales p ON p.id_estacion = e.id
            WHERE u.username = ?1
            ORDER BY u.created_at
            "#,
        )?
        .query_map(params![auth.username], |row| {
            let rotulo: Option<String> = row.get(4)?;
            let en_listado: bool = row.get(17)?;
            let antes: Option<String> = row.get(19)?;
            let rotulo_desde: Option<i64> = row.get(20)?;
            let rebranded = antes.is_some() && antes != rotulo;
            Ok(MyStation {
                kind: row.get(0)?,
                nickname: row.get(1)?,
                created_at: row.get(2)?,
                id: row.get(3)?,
                rotulo,
                horario: row.get(5)?,
                direccion: row.get(6)?,
                margen: row.get(7)?,
                municipio: row.get(8)?,
                localidad: row.get(9)?,
                provincia: row.get(10)?,
                cp: row.get(11)?,
                latitud: row.get(12)?,
                longitud: row.get(13)?,
                ultimo_cambio: row
                    .get::<_, Option<i64>>(14)?
                    .map(format_fecha)
                    .unwrap_or_default(),
                gasoleo_a: row.get(15)?,
                gasolina_95: row.get(16)?,
                en_listado,
                ultima_vez: if en_listado {
                    None
                } else {
                    row.get::<_, Option<i64>>(18)?.map(format_fecha)
                },
                rotulo_anterior: if rebranded { antes } else { None },
                rotulo_desde: rotulo_desde.filter(|_| rebranded).map(format_fecha),
            })
        })?
        .collect::<Result<_, _>>()?;
    Ok(Json(rows))
}

#[derive(Deserialize)]
struct PutStation {
    kind: Kind,
    /// Blank or null clears it.
    nickname: Option<String>,
}

/// Saves or hides a station, or changes its nickname. Saving a hidden station unhides it, and
/// the other way round.
async fn put_station(
    State(pool): State<DbPool>,
    auth: ClientAuth,
    Path(id): Path<i64>,
    Json(body): Json<PutStation>,
) -> Result<StatusCode, AppError> {
    let nickname = body
        .nickname
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty());
    if nickname.is_some_and(|n| n.chars().count() > MAX_NICKNAME_LEN) {
        return Err(AppError::BadRequest(
            format!("Nicknames must be at most {MAX_NICKNAME_LEN} characters").into(),
        ));
    }
    let conn = pool.get()?;
    let exists = conn
        .query_row(
            "SELECT 1 FROM estaciones WHERE id = ?1",
            params![id],
            |_| Ok(()),
        )
        .optional()?;
    if exists.is_none() {
        return Err(AppError::FileNotFound);
    }
    conn.execute(
        "INSERT INTO user_stations (username, station_id, kind, nickname, created_at)
        VALUES (?1, ?2, ?3, ?4, ?5)
        ON CONFLICT (username, station_id) DO UPDATE SET
            kind = excluded.kind,
            nickname = excluded.nickname,
            -- Moving it to the other list counts as adding it anew.
            created_at = CASE WHEN kind = excluded.kind THEN created_at ELSE excluded.created_at END",
        params![auth.username, id, body.kind.as_str(), nickname, now()],
    )?;
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_station(
    State(pool): State<DbPool>,
    auth: ClientAuth,
    Path(id): Path<i64>,
) -> Result<StatusCode, AppError> {
    let conn = pool.get()?;
    conn.execute(
        "DELETE FROM user_stations WHERE username = ?1 AND station_id = ?2",
        params![auth.username, id],
    )?;
    Ok(StatusCode::NO_CONTENT)
}

pub fn get_router() -> Router<DbPool> {
    Router::new()
        .route("/", get(list))
        .route("/{id}", put(put_station).delete(delete_station))
}
