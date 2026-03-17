use axum::{Json, Router, extract::{Path, Query, State}, http::StatusCode, routing::get};
use rusqlite::params;
use serde::{Serialize, Deserialize};
use tracing::warn;

use crate::DbPool;

mod user;

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

async fn latest_prices(
    State(state): State<DbPool>,
) -> Result<Json<Vec<EstacionPrecio>>, StatusCode> {

    let conn = state.get().unwrap();

    let mut stmt = conn
        .prepare(
            r#"
            WITH latest AS (
                SELECT MAX(fecha) AS fecha FROM precios
            )
            SELECT 
                e.id,
                e.rotulo,
                e.direccion,
                e.municipio,
                e.provincia,
                e.latitud,
                e.longitud,
                p.fecha,
                p.gasoleo_a,
                p.gasolina_95,
                e.margen,
                e.localidad,
                e.horario,
                e.cp
            FROM estaciones e
            JOIN precios p ON p.id_estacion = e.id
            JOIN latest l ON p.fecha = l.fecha
            "#,
        )
        .map_err(|e| {warn!("SQL Error: {e}"); StatusCode::INTERNAL_SERVER_ERROR})?;

    let rows = stmt
        .query_map([], |row| {
            Ok(EstacionPrecio {
                id: row.get(0)?,
                rotulo: row.get(1)?,
                direccion: row.get(2)?,
                municipio: row.get(3)?,
                provincia: row.get(4)?,
                latitud: row.get(5)?,
                longitud: row.get(6)?,
                fecha: row.get(7)?,
                gasoleo_a: row.get(8)?,
                gasolina_95: row.get(9)?,
                margen: row.get(10)?,
                localidad: row.get(11)?,
                horario: row.get(12)?,
                cp: row.get(13)?,
            })
        })
        .map_err(|e| {warn!("SQL Error: {e}"); StatusCode::INTERNAL_SERVER_ERROR})?;

    let mut estaciones = Vec::new();
    for row in rows {
        estaciones.push(row.map_err(|e| {warn!("SQL Error: {e}"); StatusCode::INTERNAL_SERVER_ERROR})?);
    }

    Ok(Json(estaciones))
}

#[derive(Serialize)]
struct PricePoint {
    fecha: String,
    gasoleo_a: Option<f64>,
    gasolina_95: Option<f64>,
}

#[derive(Deserialize)]
struct HistoryParams {
    from: chrono::DateTime<chrono::Utc>
}

async fn price_history(Path(id): Path<i64>, Query(params): Query<HistoryParams>, State(state): State<DbPool>,
) -> Result<Json<Vec<PricePoint>>, StatusCode> {
    let conn = state.get().unwrap();
    let tz = chrono::Local;

    let mut stmt = conn
        .prepare(
            r#"
            
            SELECT 
                fecha,
                gasoleo_a,
                gasolina_95
            FROM precios
            WHERE id_estacion = ? AND fecha >= ?
            "#,
        )
        .map_err(|e| {warn!("SQL Error: {e}"); StatusCode::INTERNAL_SERVER_ERROR})?;
    let fecha = params.from.with_timezone(&tz).format("%Y-%m-%d %H:%M:%S").to_string();
    // info!("Filtering by {fecha}");
    let rows = stmt
        .query_map(params![id, fecha], |row| {
            Ok(PricePoint {
                fecha: row.get(0)?,
                gasoleo_a: row.get(1)?,
                gasolina_95: row.get(2)?,
            })
        })
        .map_err(|e| {warn!("SQL Error: {e}"); StatusCode::INTERNAL_SERVER_ERROR})?;

    let mut precios = Vec::new();
    for row in rows {
        precios.push(row.map_err(|e| {warn!("SQL Error: {e}"); StatusCode::INTERNAL_SERVER_ERROR})?);
    }

    Ok(Json(precios))
}

pub fn get_router() -> Router<DbPool> {
	Router::new()
        .route("/prices", get(latest_prices))
        .route("/{id}/history", get(price_history))
        .nest("/user", user::get_router())
}


