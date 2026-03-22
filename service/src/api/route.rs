use axum::{Json, Router, routing::{get, post}};
use geo_types::LineString;
use polyline::errors::PolylineError;
use serde::Deserialize;
use thiserror::Error;

use crate::{DbPool, error::AppError};

#[derive(Debug, Error)]
pub enum RouteError {
    #[error(transparent)]
    Polyline(#[from] PolylineError),
    #[error(transparent)]
    Net(#[from] reqwest::Error),
}

#[derive(Debug, Deserialize)]
struct RouteRequest {
    waypoints: Vec<(f64, f64)>,
}

#[derive(Debug, Deserialize)]
struct OSRMTrip {
    geometry: String,
    duration: f64,
    distance: f64,
}

#[derive(Debug, Deserialize)]
struct RouteOSRMResponse {
    trips: Vec<OSRMTrip>,
}

async fn forward_route(waypoints: &[(f64, f64)]) -> Result<Vec<LineString<f64>>, RouteError> {
    const BASE_URI: &str = "http://router.project-osrm.org/route/v1/driving/";
    let url = format!(
        "{BASE_URI}{}",
        waypoints
            .iter()
            .map(|(lat, lon)| format!("{lat},{lon}"))
            .collect::<Vec<_>>()
            .join(";")
    );
    let resp: String = reqwest::get(url).await?.text().await?;

    tracing::info!("Trips: {resp:#?}");

    todo!()

    // Ok(resp
    //     .trips
    //     .into_iter()
    //     .map(|x| polyline::decode_polyline(&x.geometry, 5))
    //     .collect::<Result<Vec<_>, PolylineError>>()?)
}

async fn get_route(Json(req): Json<RouteRequest>) -> Result<Json<Vec<LineString<f64>>>, AppError> {
    Ok(Json(forward_route(&req.waypoints).await?))
}

pub fn get_router() -> Router<DbPool> {
    Router::new().route("/test", post(get_route))
}
