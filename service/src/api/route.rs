use axum::{
    Json, Router,
    extract::{Path, Query, State},
    routing::{get, post},
};
use bytemuck::{Pod, Zeroable};
use geo::{Closest, ClosestPoint, Distance, Haversine, HaversineDistance, Line, Point};
use geo_types::{Coord, LineString};
use polyline::errors::PolylineError;
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha3::{Digest, Sha3_256};
use thiserror::Error;

use crate::{
    DbPool,
    api::{EstacionPrecio, get_latest_station_data},
    error::AppError,
};

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

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct OSMRLeg {
    duration: f64,
    distance: f64,
    annotation: OSMRAnnotation,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct OSMRAnnotation {
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

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct OSRMRoute {
    geometry: String,
    duration: f64,
    distance: f64,
    legs: Vec<OSMRLeg>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct RouteOSRMResponse {
    code: String,
    #[serde(default)]
    pub routes: Vec<OSRMRoute>,
    #[serde(default)]
    waypoints: Vec<OSRMWaypoint>,
    message: Option<String>,
}

#[derive(Debug, Serialize)]
struct Route {
    geometry: LineString<f64>,
    duration: f64,
    distance: f64,
    legs: Vec<OSMRLeg>,
}

impl TryFrom<OSRMRoute> for Route {
    type Error = PolylineError;

    fn try_from(x: OSRMRoute) -> Result<Self, Self::Error> {
        Ok(Self {
            geometry: polyline::decode_polyline(&x.geometry, 5)?,
            duration: x.duration,
            distance: x.distance,
            legs: x.legs,
        })
    }
}

#[derive(Debug, Serialize)]
struct RoutesResponse {
    waypoints: Vec<OSRMWaypoint>,
    routes: Vec<Route>,
}

#[derive(Debug, Serialize)]
struct RouteResponse {
    waypoints: Vec<OSRMWaypoint>,
    route: Route,
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

pub async fn get_route_from_db(
    pool: DbPool,
    hash: &str,
) -> Result<Option<RouteOSRMResponse>, RouteError> {
    let conn = pool.get().unwrap();

    let data: Option<String> = conn
        .query_one(
            "SELECT data FROM routes WHERE hash = ?",
            params![hash],
            |r| r.get(0),
        )
        .optional()?;

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
async fn get_routes(
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
            .map(TryFrom::try_from)
            .collect::<Result<Vec<_>, PolylineError>>()
            .map_err(RouteError::Polyline)?,
    }))
}

async fn get_route(
    State(pool): State<DbPool>,
    Path((hash, route_idx)): Path<(String, usize)>,
) -> Result<Json<RouteResponse>, AppError> {
    let data = get_route_from_db(pool, &hash)
        .await?
        .ok_or(AppError::FileNotFound)?;

    let route = data.routes.get(route_idx).ok_or(AppError::FileNotFound)?;

    let route = Route::try_from(route.clone()).map_err(RouteError::Polyline)?;

    Ok(Json(RouteResponse {
        waypoints: data.waypoints,
        route,
    }))
}

#[derive(Serialize)]
struct PositionedStation {
    station: EstacionPrecio,
    distance_along_route: f64,
    duration: f64,
    distance_from_route: f64,
}

#[derive(Deserialize, Default)]
enum RoutePricesQueryOrderBy {
    DistanceToRoute,
    DistanceAlongRoute,
    #[default]
    None,
}

#[derive(Deserialize)]
struct RoutePricesQuery {
    max_distance: Option<f64>,
    #[serde(default)]
    order_by: RoutePricesQueryOrderBy,
}

/// Finds the closest point on segment a->b to `p`, and the fraction `t` in [0,1]
/// along a->b where that closest point sits.
fn closest_point_on_segment(p: Point<f64>, a: Coord<f64>, b: Coord<f64>) -> (Point<f64>, f64) {
    let line = Line::new(a, b);

    let closest = match line.closest_point(&p) {
        Closest::Intersection(pt) | Closest::SinglePoint(pt) => pt,
        Closest::Indeterminate => Point::from(a),
    };

    let ab = (b.x - a.x, b.y - a.y);
    let ac = (closest.x() - a.x, closest.y() - a.y);
    let len2 = ab.1.mul_add(ab.1, ab.0 * ab.0);

    let t = if len2 > 0.0 {
        (ac.1.mul_add(ab.1, ac.0 * ab.0) / len2).clamp(0.0, 1.0)
    } else {
        0.0
    };

    (closest, t)
}
async fn get_prices_on_route(
    State(pool): State<DbPool>,
    Path((hash, route_idx)): Path<(String, usize)>,
    Query(query): Query<RoutePricesQuery>,
) -> Result<Json<Vec<PositionedStation>>, AppError> {
    let stations = get_latest_station_data(pool.clone()).await?;
    let Json(route) = get_route(State(pool), Path((hash, route_idx))).await?;

    let points = &route.route.geometry.0; // Vec<Coord<f64>>, (lon, lat)

    if points.len() < 2 {
        return Ok(Json(Vec::new()));
    }

    let mut edge_distance = Vec::with_capacity(points.len() - 1);
    let mut edge_duration = Vec::with_capacity(points.len() - 1);
    for leg in &route.route.legs {
        edge_distance.extend_from_slice(&leg.annotation.distance);
        edge_duration.extend_from_slice(&leg.annotation.duration);
    }

    if edge_distance.len() != points.len() - 1 {
        tracing::warn!(
            "annotation edge count ({}) != geometry edge count ({})",
            edge_distance.len(),
            points.len() - 1
        );
    }

    let mut cum_dist = vec![0.0; points.len()];
    let mut cum_dur = vec![0.0; points.len()];
    for i in 0..edge_distance.len().min(points.len() - 1) {
        cum_dist[i + 1] = cum_dist[i] + edge_distance[i];
        cum_dur[i + 1] = cum_dur[i] + edge_duration[i];
    }

    let mut res: Vec<PositionedStation> = stations
        .into_iter()
        .filter_map(|station| {
            let p = Point::new(station.longitud, station.latitud);

            let mut best: Option<(f64, usize, f64)> = None; // (dist_from_route, seg_idx, t)
            for i in 0..points.len() - 1 {
                let (closest, t) = closest_point_on_segment(p, points[i], points[i + 1]);

                let d = Haversine.distance(p, closest); // p.haversine_distance(&closest);
                if best.is_none_or(|(bd, ..)| d < bd) {
                    best = Some((d, i, t));
                }
            }
            let (distance_from_route, seg_idx, t) = best?;

            if let Some(max_d) = query.max_distance
                && distance_from_route > max_d
            {
                return None;
            }

            let edge_d = edge_distance.get(seg_idx).copied().unwrap_or(0.0);
            let edge_t = edge_duration.get(seg_idx).copied().unwrap_or(0.0);

            Some(PositionedStation {
                distance_along_route: t.mul_add(edge_d, cum_dist[seg_idx]),
                duration: t.mul_add(edge_t, cum_dur[seg_idx]),
                distance_from_route,
                station,
            })
        })
        .collect();

    match query.order_by {
        RoutePricesQueryOrderBy::DistanceToRoute => res.sort_by(|a, b| {
            a.distance_from_route
                .partial_cmp(&b.distance_from_route)
                .unwrap_or(std::cmp::Ordering::Equal)
        }),
        RoutePricesQueryOrderBy::DistanceAlongRoute => res.sort_by(|a, b| {
            a.distance_along_route
                .partial_cmp(&b.distance_along_route)
                .unwrap_or(std::cmp::Ordering::Equal)
        }),
        RoutePricesQueryOrderBy::None => {}
    }

    Ok(Json(res))
}

pub fn get_router() -> Router<DbPool> {
    Router::new()
        .route("/", post(create_route))
        .route("/{hash}", get(get_routes))
        .route("/{hash}/{route_idx}", get(get_route))
        .route("/{hash}/{route_idx}/prices", get(get_prices_on_route))
}
