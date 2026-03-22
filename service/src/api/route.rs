use axum::Router;
use geo_types::LineString;
use polyline::errors::PolylineError;
use serde::Deserialize;
use thiserror::Error;

use crate::DbPool;

#[derive(Debug, Error)]
enum RouteError {
    #[error(transparent)]
    Polyline(#[from] PolylineError)
}

#[derive(Debug, Deserialize)]
struct RouteRequest {
    waypoints: Vec<(f64, f64)>
}

async fn forward_route(waypoints: &[(f64, f64)]) -> Result<LineString<f64>, RouteError> {
    todo!()
}



pub fn get_router() -> Router<DbPool> {
    Router::new()
}
