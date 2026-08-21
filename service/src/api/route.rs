use axum::{Json, Router, routing::{get, post}};
use bytemuck::{Pod, Zeroable};
use geo_types::LineString;
use polyline::errors::PolylineError;
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
}

#[derive(Debug, Deserialize, Pod, Clone, Copy, PartialEq, Zeroable)]
#[repr(C)]
struct Waypoint(f64, f64);

#[derive(Debug, Deserialize)]
struct RouteRequest {
    waypoints: Vec<Waypoint>,
}

#[derive(Debug, Deserialize)]
struct OSMRLeg {
    duration: f64,
    distance: f64,
    annotation: OSMRAnnotation
}

#[derive(Debug, Deserialize)]
struct OSMRAnnotation {
    distance: Vec<f64>,
    duration: Vec<f64>
}


#[derive(Debug, Deserialize)]
struct OSRMRoute {
    geometry: String,
    duration: f64,
    distance: f64,
    // legs: Vec<OSMRLeg>
}

#[derive(Debug, Deserialize)]
struct RouteOSRMResponse {
    code: String,
    #[serde(default)]
    routes: Vec<OSRMRoute>,
    message: Option<String>,
}

#[derive(Debug, Serialize)]
struct RouteResponse {
    geometry: LineString<f64>,
    duration: f64,
    distance: f64,
}

async fn forward_route(waypoints: &[Waypoint]) -> Result<Vec<RouteResponse>, RouteError> {
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
        return Err(RouteError::NoRoute(
            parsed.message.unwrap_or(parsed.code),
        ));
    }


    // tracing::info!("Trips: {resp:#?}");



    Ok(parsed
        .routes
        .into_iter()
        .map(|x| {
            Ok(RouteResponse {
                geometry: polyline::decode_polyline(&x.geometry, 5)?,
                duration: x.duration,
                distance: x.distance,
            })
        })
        .collect::<Result<Vec<_>, PolylineError>>()?)
}

async fn get_route(Json(req): Json<RouteRequest>) -> Result<Json<Vec<RouteResponse>>, AppError> {
    let hash = Sha3_256::new().chain_update(bytemuck::cast_slice(&req.waypoints)).finalize();

    tracing::info!("Hash: {}", hash.iter().map(|a| format!("{a:02x}")).reduce(|a, b| a + &b).unwrap_or_default());

    Ok(Json(forward_route(&req.waypoints).await?))
}

pub fn get_router() -> Router<DbPool> {
    Router::new().route("/", post(get_route))
}
