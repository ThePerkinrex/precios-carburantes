use std::time::Instant;

use axum::{
    Json, Router,
    extract::{Path, Query, State},
    routing::get,
};
use geo::{Closest, ClosestPoint, Distance, Haversine, Line, Point};
use geo_types::Coord;
use rayon::iter::{IntoParallelIterator, ParallelIterator};
use rstar::{AABB, PointDistance, RTree, RTreeObject};
use serde::{Deserialize, Serialize};
use tracing::debug;

use crate::{
    DbPool,
    api::{EstacionPrecio, get_latest_station_data, route::get_route},
    error::AppError,
};

struct IndexedSegment {
    idx: usize,
    a: Coord<f64>,
    b: Coord<f64>,
}

impl RTreeObject for IndexedSegment {
    type Envelope = AABB<[f64; 2]>;
    fn envelope(&self) -> Self::Envelope {
        AABB::from_corners(
            [self.a.x.min(self.b.x), self.a.y.min(self.b.y)],
            [self.a.x.max(self.b.x), self.a.y.max(self.b.y)],
        )
    }
}

impl PointDistance for IndexedSegment {
    fn distance_2(&self, point: &[f64; 2]) -> f64 {
        let p = Point::new(point[0], point[1]);
        let (closest, _) = closest_point_on_segment(p, self.a, self.b);
        let dx = closest.x() - point[0];
        let dy = closest.y() - point[1];
        dy.mul_add(dy, dx * dx)
    }
}

#[derive(Serialize)]
struct PositionedStation {
	#[serde(flatten)]
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
    let start = Instant::now();
    let (stations, Json(route)) = tokio::try_join!(
        get_latest_station_data(pool.clone()),
        get_route(State(pool), Path((hash.clone(), route_idx))),
    )?;

    debug!("Get data: {:.4}s", start.elapsed().as_secs_f64());
    let start = Instant::now();

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

    debug!("Preprocess: {:.4}s", start.elapsed().as_secs_f64());
    let start = Instant::now();

    let padding_deg = query.max_distance.unwrap_or(50_000.0) / 111_000.0; // rough m -> deg
    let (mut min_x, mut max_x, mut min_y, mut max_y) = (f64::MAX, f64::MIN, f64::MAX, f64::MIN);
    for c in points {
        min_x = min_x.min(c.x);
        max_x = max_x.max(c.x);
        min_y = min_y.min(c.y);
        max_y = max_y.max(c.y);
    }
    let stations: Vec<_> = stations
        .into_iter()
        .filter(|s| {
            s.longitud >= min_x - padding_deg
                && s.longitud <= max_x + padding_deg
                && s.latitud >= min_y - padding_deg
                && s.latitud <= max_y + padding_deg
        })
        .collect();

    debug!(
        "Bbox prefilter: {:.4}s, {} stations remain",
        start.elapsed().as_secs_f64(),
        stations.len()
    );
    // let start = Instant::now();

    // let mut res: Vec<PositionedStation> = stations
    //     .into_par_iter()
    //     .filter_map(|station| {
    //         let p = Point::new(station.longitud, station.latitud);

    //         let mut best: Option<(f64, usize, f64)> = None; // (dist_from_route, seg_idx, t)
    //         for i in 0..points.len() - 1 {
    //             let (closest, t) = closest_point_on_segment(p, points[i], points[i + 1]);

    //             let d = Haversine.distance(p, closest); // p.haversine_distance(&closest);
    //             if best.is_none_or(|(bd, ..)| d < bd) {
    //                 best = Some((d, i, t));
    //             }
    //         }
    //         let (distance_from_route, seg_idx, t) = best?;

    //         if let Some(max_d) = query.max_distance
    //             && distance_from_route > max_d
    //         {
    //             return None;
    //         }

    //         let edge_d = edge_distance.get(seg_idx).copied().unwrap_or(0.0);
    //         let edge_t = edge_duration.get(seg_idx).copied().unwrap_or(0.0);

    //         Some(PositionedStation {
    //             distance_along_route: t.mul_add(edge_d, cum_dist[seg_idx]),
    //             duration: t.mul_add(edge_t, cum_dur[seg_idx]),
    //             distance_from_route,
    //             station,
    //         })
    //     })
    //     .collect();

    // debug!("Filter-map: {:.4}s", start.elapsed().as_secs_f64());

    let start = Instant::now();

    let segments: Vec<IndexedSegment> = points
        .windows(2)
        .enumerate()
        .map(|(idx, w)| IndexedSegment {
            idx,
            a: w[0],
            b: w[1],
        })
        .collect();
    let tree = RTree::bulk_load(segments);

    debug!(
        "RTree build: {:.4}s, {} segments",
        start.elapsed().as_secs_f64(),
        points.len() - 1
    );
    let start = Instant::now();

    let mut res: Vec<PositionedStation> = stations
        .into_par_iter()
        .filter_map(|station| {
            let p = Point::new(station.longitud, station.latitud);

            let nearest = tree.nearest_neighbor([p.x(), p.y()])?;
            let (closest, t) = closest_point_on_segment(p, nearest.a, nearest.b);
            let distance_from_route = Haversine.distance(p, closest);
            let seg_idx = nearest.idx;

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

    debug!(
        "Filter-map (rtree query): {:.4}s",
        start.elapsed().as_secs_f64()
    );
    let start = Instant::now();

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

    debug!("Order: {:.4}s", start.elapsed().as_secs_f64());

    Ok(Json(res))
}

pub fn get_router() -> Router<DbPool> {
    Router::new().route("/", get(get_prices_on_route))
}
