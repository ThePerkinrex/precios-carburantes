use chrono::Local;
use rusqlite::{Result, params};
use serde::{Deserialize, Deserializer};
use std::{error::Error, time::Instant};

use database_access::{DEFAULT_DB_PATH, get_connection_manager};

// --- Modelos de Datos ---

#[derive(Debug, Deserialize)]
struct ApiResponse {
    #[serde(rename = "Fecha")]
    _fecha: String,
    #[serde(rename = "ListaEESSPrecio")]
    lista_eess: Vec<EstacionRaw>,
}

#[derive(Debug, Deserialize)]
struct EstacionRaw {
    #[serde(rename = "IDEESS")]
    id_eess: String,
    #[serde(rename = "Rótulo")]
    rotulo: String,
    #[serde(
        rename = "Longitud (WGS84)",
        deserialize_with = "parse_spanish_float_forced"
    )]
    longitud: f64,
    #[serde(rename = "Latitud", deserialize_with = "parse_spanish_float_forced")]
    latitud: f64,
    #[serde(rename = "Dirección")]
    direccion: String,
    #[serde(rename = "Margen")]
    margen: String,
    #[serde(rename = "C.P.")]
    postal_code: String,
    #[serde(rename = "Horario")]
    horario: String,
    #[serde(rename = "Municipio")]
    municipio: String,
    #[serde(rename = "Localidad")]
    localidad: String,
    #[serde(rename = "Provincia")]
    provincia: String,
    #[serde(rename = "IDMunicipio")]
    id_municipio: String,
    #[serde(rename = "IDProvincia")]
    id_provincia: String,
    #[serde(rename = "IDCCAA")]
    id_ccaa: String,
    #[serde(
        rename = "Precio Gasoleo A",
        deserialize_with = "parse_spanish_float_maybe"
    )]
    precio_gasoleo_a: Option<f64>,
    #[serde(
        rename = "Precio Gasolina 95 E5",
        deserialize_with = "parse_spanish_float_maybe"
    )]
    precio_gasolina_95: Option<f64>,
}

// Función para convertir "1,779" -> 1.779
fn parse_spanish_float_maybe<'de, D>(deserializer: D) -> Result<Option<f64>, D::Error>
where
    D: Deserializer<'de>,
{
    let s: String = Deserialize::deserialize(deserializer)?;
    if s.is_empty() {
        return Ok(None);
    }
    s.replace(',', ".")
        .parse::<f64>()
        .map(Some)
        .map_err(serde::de::Error::custom)
}

fn parse_spanish_float_forced<'de, D>(deserializer: D) -> Result<f64, D::Error>
where
    D: Deserializer<'de>,
{
    parse_spanish_float_maybe(deserializer)
        .and_then(|x| x.ok_or_else(|| serde::de::Error::custom("Unexpected empty float")))
}

// --- Lógica Principal ---

fn main_internal() -> Result<(), Box<dyn Error>> {
    let manager = get_connection_manager(DEFAULT_DB_PATH)?;
    let pool = r2d2::Pool::new(manager)?;
    let mut conn = pool.get()?;

    let start = Instant::now();

    // 2. Descargar Datos
    println!("Descargando datos de la API...");
    let url = "https://sedeaplicaciones.minetur.gob.es/ServiciosRESTCarburantes/PreciosCarburantes/EstacionesTerrestres/";

    // Creamos un cliente con un User-Agent de un navegador moderno
    let client = reqwest::blocking::Client::builder()
        .user_agent("PrecioCarburantes/1.0.0")
        .http1_only()
        .build()?;

    // Usamos el cliente para la petición
    let resp: ApiResponse = client
        .get(url)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()?
        .json()?;

    let num_estaciones = resp.lista_eess.len();
    if num_estaciones == 0 {
        println!("Ninguna estación encontrada");
        // This will cause the service to fail, and systemd will show it as an error
        return Err("La API devolvió 0 estaciones. Abortando para evitar registros vacíos.".into());
    }
    println!("Descargadas {} estaciones en {:.2}s.", num_estaciones, start.elapsed().as_secs_f32());

    // Normalizar fecha de la API (tomamos solo la parte de la fecha)
    let ahora = Local::now().format("%Y-%m-%d %H:%M:%S").to_string();

    // 3. Inserción Eficiente (Transacción)
    let tx = conn.transaction()?;

    for est in resp.lista_eess {
        let id: i32 = est.id_eess.parse().unwrap_or(0);

        // Actualizamos metadatos y gestionamos fechas de avistamiento
        // COALESCE asegura que 'first_seen' solo se escriba la primera vez
        tx.execute(
            "INSERT INTO estaciones (
                id, rotulo, direccion, margen, cp, horario, municipio, 
                localidad, provincia, id_municipio, id_provincia, id_ccaa, 
                longitud, latitud, first_seen, last_seen
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?15)
            ON CONFLICT(id) DO UPDATE SET 
                rotulo = excluded.rotulo,
                direccion = excluded.direccion,
                horario = excluded.horario,
                last_seen = excluded.last_seen",
            params![
                id,
                est.rotulo,
                est.direccion,
                est.margen,
                est.postal_code,
                est.horario,
                est.municipio,
                est.localidad,
                est.provincia,
                est.id_municipio,
                est.id_provincia,
                est.id_ccaa,
                est.longitud,
                est.latitud,
                ahora
            ],
        )?;

        // Insertar precio diario
        tx.execute(
            "INSERT OR REPLACE INTO precios (fecha, id_estacion, gasoleo_a, gasolina_95) 
             VALUES (?1, ?2, ?3, ?4)",
            params![ahora, id, est.precio_gasoleo_a, est.precio_gasolina_95],
        )?;
    }

    tx.commit()?;
    println!("Datos guardados correctamente para la fecha: {} en {:.2}s", ahora, start.elapsed().as_secs_f32());

    Ok(())
}

fn main() -> Result<(), Box<dyn Error>> {
    let start = Instant::now();
    let res = main_internal();
    println!("Completado con resultado {res:?} en {:.2}s", start.elapsed().as_secs_f32());
    res
}
