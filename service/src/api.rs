use axum::{Json, Router, extract::State, routing::get};
use serde::Serialize;

use crate::DbPool;

#[derive(Serialize)]
struct EstacionPrecio {
    id: i64,
    rotulo: Option<String>,
    direccion: Option<String>,
    municipio: Option<String>,
    provincia: Option<String>,
    latitud: f64,
    longitud: f64,
    fecha: String,
    gasoleo_a: Option<f64>,
    gasolina_95: Option<f64>,
}

async fn latest_prices(
    State(state): State<DbPool>,
) -> Result<Json<Vec<EstacionPrecio>>, String> {

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
                p.gasolina_95
            FROM estaciones e
            JOIN precios p ON p.id_estacion = e.id
            JOIN latest l ON p.fecha = l.fecha
            "#,
        )
        .map_err(|e| e.to_string())?;

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
            })
        })
        .map_err(|e| e.to_string())?;

    let mut estaciones = Vec::new();
    for row in rows {
        estaciones.push(row.map_err(|e| e.to_string())?);
    }

    Ok(Json(estaciones))
}


pub fn get_router() -> Router<DbPool> {
	Router::new().route("/prices", get(latest_prices))
}


