use axum::{
    Json, Router,
    extract::{Path, State},
    routing::{get, post},
};
use bytemuck::{Pod, Zeroable};
use geo_types::LineString;
use polyline::errors::PolylineError;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha3::{Digest, Sha3_256};
use thiserror::Error;

use crate::{DbPool, error::AppError};

#[derive(Debug, Error)]
pub enum RouteError {
    #[error("Polyline: {0}")]
    Polyline(#[from] PolylineError),
    #[error("Net: {0}")]
    Net(#[from] reqwest::Error),
    #[error("Parse: {0}")]
    Parse(#[from] serde_json::Error),
    #[error("OSRM could not find a route: {0}")]
    NoRoute(String),
    #[error("DB: {0}")]
    Db(#[from] rusqlite::Error),
}

#[derive(Debug, Deserialize, Pod, Clone, Copy, PartialEq, Zeroable)]
#[repr(C)]
struct Waypoint(f64, f64);

#[derive(Debug, Deserialize)]
struct RouteRequest {
    waypoints: Vec<Waypoint>,
}

#[derive(Debug, Deserialize, Serialize)]
struct OSMRLeg {
    duration: f64,
    distance: f64,
    annotation: OSMRAnnotation,
}

#[derive(Debug, Deserialize, Serialize)]
struct OSMRAnnotation {
    distance: Vec<f64>,
    duration: Vec<f64>,
}

#[derive(Debug, Deserialize, Serialize)]
struct OSRMWaypoint {
    hint: String,
    name: String,
    distance: f64,
    location: (f64, f64),
}

#[derive(Debug, Deserialize, Serialize)]
struct OSRMRoute {
    geometry: String,
    duration: f64,
    distance: f64,
    legs: Vec<OSMRLeg>,
}

#[derive(Debug, Deserialize, Serialize)]
struct RouteOSRMResponse {
    code: String,
    #[serde(default)]
    routes: Vec<OSRMRoute>,
    #[serde(default)]
    waypoints: Vec<OSRMWaypoint>,
    message: Option<String>,
}

#[derive(Debug, Serialize)]
struct Route {
    geometry: LineString<f64>,
    duration: f64,
    distance: f64,
}

#[derive(Debug, Serialize)]
struct RoutesResponse {
    waypoints: Vec<OSRMWaypoint>,
    routes: Vec<Route>,
}

async fn query_osrm(waypoints: &[Waypoint]) -> Result<RouteOSRMResponse, RouteError> {
    const BASE_URI: &str = "http://router.project-osrm.org/route/v1/driving/";
    let url = format!(
        "{BASE_URI}{}?annotations=distance,duration&overview=full&alternatives=3",
        waypoints
            .iter()
            .map(|Waypoint(lat, lon)| format!("{lon},{lat}"))
            .collect::<Vec<_>>()
            .join(";")
    );
    tracing::info!("URL: {url}");

    // tracing::info!("{}", reqwest::get(&url).await?.text().await?);

    let client = reqwest::Client::builder()
        .user_agent("precios-carburantes/0.1 (contact: theperkinrex@gmail.com)")
        .build()?;

    let resp = client.get(&url).send().await?;
    let status = resp.status();
    let body = resp.text().await?; // read raw text, not .json()

    if !status.is_success() {
        tracing::warn!("OSRM status={status} body={body}");
    }

    let parsed: RouteOSRMResponse = match serde_json::from_str(&body) {
        Ok(p) => p,
        Err(e) => {
            tracing::error!("Failed to parse OSRM response: {e}\nBody was: {body}");
            return Err(RouteError::Parse(e));
        }
    };

    if parsed.code != "Ok" {
        return Err(RouteError::NoRoute(parsed.message.unwrap_or(parsed.code)));
    }

    Ok(parsed)
}

async fn get_route_from_db(
    pool: DbPool,
    hash: &str,
) -> Result<Option<RouteOSRMResponse>, RouteError> {
    let conn = pool.get().unwrap();

    let data: Option<String> = conn.query_one(
        "SELECT data FROM routes WHERE hash = ?",
        params![hash],
        |r| r.get(0),
    ).optional()?;

    if let Some(data) = data {
        let res: RouteOSRMResponse = serde_json::from_str(&data)?;

        Ok(Some(res))
    } else {
        Ok(None)
    }
}

async fn find_routes(pool: DbPool, waypoints: &[Waypoint]) -> Result<String, RouteError> {
    let hash = Sha3_256::new()
        .chain_update(bytemuck::cast_slice(waypoints))
        .finalize();
    let hash = hash
        .iter()
        .map(|a| format!("{a:02x}"))
        .reduce(|a, b| a + &b)
        .unwrap_or_default();

    tracing::info!("Hash: {hash}");

    if get_route_from_db(pool.clone(), &hash).await?.is_none() {
        let conn = pool.get().unwrap();

        let data = query_osrm(waypoints).await?;
        let data = serde_json::to_string(&data)?;

        conn.execute(
            "INSERT INTO routes(hash, data) VALUES(?, ?)",
            params![&hash, &data],
        )?;
    }

    // tracing::info!("Trips: {resp:#?}");

    // Ok(parsed
    //     .routes
    //     .into_iter()
    //     .map(|x| {
    //         Ok(RouteResponse {
    //             geometry: polyline::decode_polyline(&x.geometry, 5)?,
    //             duration: x.duration,
    //             distance: x.distance,
    //         })
    //     })
    //     .collect::<Result<Vec<_>, PolylineError>>()?)

    Ok(hash)
}

#[derive(Debug, Serialize)]
struct CreateRouteResponse {
    hash: String,
}

async fn create_route(
    State(state): State<DbPool>,
    Json(req): Json<RouteRequest>,
) -> Result<Json<CreateRouteResponse>, AppError> {
    Ok(Json(CreateRouteResponse {
        hash: find_routes(state, &req.waypoints).await?,
    }))
}

#[axum_macros::debug_handler]
async fn get_route(
    State(pool): State<DbPool>,
    Path(hash): Path<String>,
) -> Result<Json<RoutesResponse>, AppError> {
    let data = get_route_from_db(pool, &hash)
        .await?
        .ok_or(AppError::FileNotFound)?;

    Ok(Json(RoutesResponse {
        waypoints: data.waypoints,
        routes: data
            .routes
            .into_iter()
            .map(|x| {
                Ok(Route {
                    geometry: polyline::decode_polyline(&x.geometry, 5)?,
                    duration: x.duration,
                    distance: x.distance,
                })
            })
            .collect::<Result<Vec<_>, PolylineError>>()
            .map_err(RouteError::Polyline)?,
    }))
}

pub fn get_router() -> Router<DbPool> {
    Router::new()
        .route("/", post(create_route))
        .route("/{hash}", get(get_route))
}
