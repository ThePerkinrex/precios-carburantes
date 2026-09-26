use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::StatusCode,
    routing::get,
};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use tracing::warn;

use crate::{DbPool, error::AppError};

mod admin;
mod geo;
pub mod route;
mod user;

/// `precios.fecha` is stored as unix seconds; the API exposes it as local time text.
fn format_fecha(ts: i64) -> String {
    chrono::DateTime::from_timestamp(ts, 0)
        .map(|d| d.with_timezone(&chrono::Local).format("%Y-%m-%d %H:%M:%S").to_string())
        .unwrap_or_default()
}

#[derive(Serialize)]
struct EstacionPrecio {
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
    fecha: String,
    gasoleo_a: Option<f64>,
    gasolina_95: Option<f64>,
}

async fn get_latest_station_data(pool: DbPool) -> Result<Vec<EstacionPrecio>, AppError> {
    let conn = pool.get().unwrap();

    let mut stmt = conn.prepare(
        r#"
            SELECT 
                e.id,
                e.rotulo,
                e.direccion,
                e.municipio,
                e.provincia,
                e.latitud,
                e.longitud,
                (SELECT MAX(fecha) FROM snapshots),
                p.gasoleo_a,
                p.gasolina_95,
                e.margen,
                e.localidad,
                e.horario,
                e.cp
            FROM estaciones e
            JOIN precios_actuales p ON p.id_estacion = e.id
            "#,
    )?;

    let rows = stmt.query_map([], |row| {
        Ok(EstacionPrecio {
            id: row.get(0)?,
            rotulo: row.get(1)?,
            direccion: row.get(2)?,
            municipio: row.get(3)?,
            provincia: row.get(4)?,
            latitud: row.get(5)?,
            longitud: row.get(6)?,
            fecha: format_fecha(row.get(7)?),
            gasoleo_a: row.get(8)?,
            gasolina_95: row.get(9)?,
            margen: row.get(10)?,
            localidad: row.get(11)?,
            horario: row.get(12)?,
            cp: row.get(13)?,
        })
    })?;

    let mut estaciones = Vec::new();
    for row in rows {
        estaciones.push(row?);
    }

    Ok(estaciones)
}

async fn latest_prices(State(pool): State<DbPool>) -> Result<Json<Vec<EstacionPrecio>>, AppError> {
    get_latest_station_data(pool).await.map(Json)
}

#[derive(Serialize)]
struct PricePoint {
    fecha: String,
    gasoleo_a: Option<f64>,
    gasolina_95: Option<f64>,
}

#[derive(Serialize)]
struct PriceChange {
    fecha: String,
    reportado: bool,
    gasoleo_a: Option<f64>,
    gasolina_95: Option<f64>,
}

/// A station's prices are stored only when they change: the frontend rebuilds the value at
/// every snapshot from the last change at or before it.
#[derive(Serialize)]
struct StationHistory {
    /// Every download since `from`.
    snapshots: Vec<String>,
    /// The station's changes since `from`, plus the last one before it.
    changes: Vec<PriceChange>,
}

#[derive(Deserialize)]
struct StationHistoryParams {
    from: chrono::DateTime<chrono::Utc>,
}

async fn price_history_station(
    Path(id): Path<i64>,
    Query(params): Query<StationHistoryParams>,
    State(state): State<DbPool>,
) -> Result<Json<StationHistory>, AppError> {
    let conn = state.get().unwrap();
    let from = params.from.timestamp();

    let snapshots = conn
        .prepare("SELECT fecha FROM snapshots WHERE fecha >= ? ORDER BY fecha ASC")?
        .query_map(params![from], |row| Ok(format_fecha(row.get(0)?)))?
        .collect::<Result<_, _>>()?;

    let changes = conn
        .prepare(
            r#"
            SELECT fecha, reportado, gasoleo_a, gasolina_95
            FROM precios
            WHERE id_estacion = ?1
              AND fecha >= COALESCE((SELECT MAX(fecha) FROM precios WHERE id_estacion = ?1 AND fecha <= ?2), ?2)
            ORDER BY fecha ASC
            "#,
        )?
        .query_map(params![id, from], |row| {
            Ok(PriceChange {
                fecha: format_fecha(row.get(0)?),
                reportado: row.get(1)?,
                gasoleo_a: row.get(2)?,
                gasolina_95: row.get(3)?,
            })
        })?
        .collect::<Result<_, _>>()?;

    Ok(Json(StationHistory { snapshots, changes }))
}

#[derive(Deserialize)]
struct HistoryParams {
    ccaa_id: Option<String>,
    provincia_id: Option<String>,
}

async fn price_history(
    Query(params): Query<HistoryParams>,
    State(state): State<DbPool>,
) -> Result<Json<Vec<PricePoint>>, StatusCode> {
    let conn = state.get().unwrap();
    // let tz = chrono::Local;

    let mut stmt = conn
        .prepare(
            r#"
            SELECT
    fecha,
    SUM(suma_gasoleo_a) / SUM(n_gasoleo_a) AS avg_gasoleo,
    SUM(suma_gasolina_95) / SUM(n_gasolina_95) AS avg_gasolina
FROM precios_provincia
WHERE (?1 IS NULL OR id_ccaa = ?1)
  AND (?2 IS NULL OR id_provincia = ?2)
GROUP BY fecha
ORDER BY fecha ASC;
            "#,
        )
        .map_err(|e| {
            warn!("SQL Error: {e}");
            StatusCode::INTERNAL_SERVER_ERROR
        })?;

    // info!("Filtering by {fecha}");
    let rows = stmt
        .query_map(params![params.ccaa_id, params.provincia_id], |row| {
            Ok(PricePoint {
                fecha: format_fecha(row.get(0)?),
                gasoleo_a: row.get(1)?,
                gasolina_95: row.get(2)?,
            })
        })
        .map_err(|e| {
            warn!("SQL Error: {e}");
            StatusCode::INTERNAL_SERVER_ERROR
        })?;

    let mut precios = Vec::new();
    for row in rows {
        precios.push(row.map_err(|e| {
            warn!("SQL Error: {e}");
            StatusCode::INTERNAL_SERVER_ERROR
        })?);
    }

    Ok(Json(precios))
}

pub fn get_router() -> Router<DbPool> {
    Router::new()
        .route("/prices", get(latest_prices))
        .route("/prices/history", get(price_history))
        .route("/{id}/history", get(price_history_station))
        .nest("/user", user::get_router())
        .nest("/admin", admin::get_router())
        .nest("/geo", geo::get_router())
        .nest("/route/", route::get_router())
}
