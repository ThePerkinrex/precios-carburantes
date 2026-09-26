//! Saved trips: a route plus the owner's review of its stations (the
//! blacklist), so the fuel plan can be recomputed with current prices every
//! time the trip is driven.
//!
//! Trips are private. Anyone but the owner gets a 404 for them, unless they
//! claimed a share link: the owner creates a single-use link, and the first
//! user to open it gets read-only access to the trip (under the same id)
//! until the owner revokes it. Everyone else still gets a 404 for the link.

use std::collections::HashMap;

use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post, put},
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::{
    DbPool,
    api::route::{
        RouteOSRMResponse, RouteSummary, forget_route_if_unused, load_route, require_route_access,
    },
    auth::ClientAuth,
    enroll::{hash_token, now, random_hex},
    error::{AppError, GenericSilentError},
};

const SHARE_TTL_SECS: i64 = 7 * 24 * 3600;
const MAX_NAME_LEN: usize = 100;
const RECENT_SEARCHES: i64 = 50;

#[derive(PartialEq)]
enum Access {
    Owner,
    /// Claimed a share link for the trip.
    Shared,
}

/// What `username` may do with trip `id`. Trips they can't see are
/// indistinguishable from trips that don't exist.
fn trip_access(conn: &Connection, id: &str, username: &str) -> Result<Access, AppError> {
    let owner: Option<String> = conn
        .query_row(
            "SELECT username FROM trips WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
        .optional()?;
    match owner {
        Some(owner) if owner == username => Ok(Access::Owner),
        Some(_) => {
            let shared: bool = conn.query_row(
                "SELECT EXISTS (SELECT 1 FROM trip_shares WHERE trip_id = ?1 AND claimed_by = ?2)",
                params![id, username],
                |r| r.get(0),
            )?;
            if shared {
                Ok(Access::Shared)
            } else {
                Err(AppError::FileNotFound)
            }
        }
        None => Err(AppError::FileNotFound),
    }
}

fn require_owner(conn: &Connection, id: &str, username: &str) -> Result<(), AppError> {
    match trip_access(conn, id, username)? {
        Access::Owner => Ok(()),
        Access::Shared => Err(AppError::FileNotFound),
    }
}

fn validate_trip_name(name: &str) -> Result<&str, AppError> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > MAX_NAME_LEN {
        return Err(AppError::BadRequest(
            format!("Trip names must be 1-{MAX_NAME_LEN} characters").into(),
        ));
    }
    Ok(name)
}

fn validate_max_distance(max_distance: Option<f64>) -> Result<(), AppError> {
    match max_distance {
        Some(d) if !(d.is_finite() && d > 0.0) => Err(AppError::BadRequest(
            "max_distance must be a positive number of meters".into(),
        )),
        _ => Ok(()),
    }
}

/// Loads each distinct route once and summarizes (hash, route_idx) pairs.
struct Summaries<'a> {
    conn: &'a Connection,
    routes: HashMap<String, Option<RouteOSRMResponse>>,
}

impl<'a> Summaries<'a> {
    fn new(conn: &'a Connection) -> Self {
        Self {
            conn,
            routes: HashMap::new(),
        }
    }

    fn route(&mut self, hash: &str) -> Result<Option<&RouteOSRMResponse>, AppError> {
        if !self.routes.contains_key(hash) {
            let route = load_route(self.conn, hash)?;
            self.routes.insert(hash.to_string(), route);
        }
        Ok(self.routes[hash].as_ref())
    }

    fn get(&mut self, hash: &str, route_idx: u32) -> Result<Option<RouteSummary>, AppError> {
        Ok(self
            .route(hash)?
            .and_then(|r| r.summary(route_idx as usize)))
    }
}

#[derive(Serialize)]
struct TripListItem {
    id: String,
    name: String,
    hash: String,
    route_idx: u32,
    last_used_at: i64,
    route: Option<RouteSummary>,
}

#[derive(Serialize)]
struct SharedTripListItem {
    id: String,
    name: String,
    hash: String,
    route_idx: u32,
    owner: String,
    claimed_at: Option<i64>,
    route: Option<RouteSummary>,
}

/// A route the user searched, with all of its alternatives.
#[derive(Serialize)]
struct RouteSearch {
    hash: String,
    searched_at: i64,
    last_used_at: i64,
    /// The alternative last opened in the planner, if any.
    last_route_idx: Option<u32>,
    alternatives: Vec<RouteSummary>,
}

#[derive(Serialize)]
struct TripList {
    saved: Vec<TripListItem>,
    shared_with_me: Vec<SharedTripListItem>,
    searches: Vec<RouteSearch>,
}

async fn list_trips(
    State(pool): State<DbPool>,
    auth: ClientAuth,
) -> Result<Json<TripList>, AppError> {
    let conn = pool.get()?;
    let mut summaries = Summaries::new(&conn);

    let saved = conn
        .prepare(
            "SELECT id, name, hash, route_idx, last_used_at FROM trips
             WHERE username = ?1 ORDER BY last_used_at DESC",
        )?
        .query_map(params![auth.username], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get::<_, String>(2)?,
                r.get(3)?,
                r.get(4)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .map(|(id, name, hash, route_idx, last_used_at)| {
            Ok(TripListItem {
                route: summaries.get(&hash, route_idx)?,
                id,
                name,
                hash,
                route_idx,
                last_used_at,
            })
        })
        .collect::<Result<_, AppError>>()?;

    let shared_with_me = conn
        .prepare(
            "SELECT t.id, t.name, t.hash, t.route_idx, COALESCE(u.display_name, t.username),
                MAX(s.claimed_at)
             FROM trip_shares s
             JOIN trips t ON t.id = s.trip_id
             LEFT JOIN user_configs u ON u.username = t.username
             WHERE s.claimed_by = ?1
             GROUP BY t.id
             ORDER BY MAX(s.claimed_at) DESC",
        )?
        .query_map(params![auth.username], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get::<_, String>(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .map(|(id, name, hash, route_idx, owner, claimed_at)| {
            Ok(SharedTripListItem {
                route: summaries.get(&hash, route_idx)?,
                id,
                name,
                hash,
                route_idx,
                owner,
                claimed_at,
            })
        })
        .collect::<Result<_, AppError>>()?;

    let searches = conn
        .prepare(
            "SELECT hash, searched_at, last_used_at, last_route_idx FROM route_searches
             WHERE username = ?1 ORDER BY MAX(searched_at, last_used_at) DESC LIMIT ?2",
        )?
        .query_map(params![auth.username, RECENT_SEARCHES], |r| {
            Ok((r.get::<_, String>(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })?
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .map(|(hash, searched_at, last_used_at, last_route_idx)| {
            Ok(RouteSearch {
                alternatives: summaries
                    .route(&hash)?
                    .map(|r| r.summaries())
                    .unwrap_or_default(),
                hash,
                searched_at,
                last_used_at,
                last_route_idx,
            })
        })
        .collect::<Result<_, AppError>>()?;

    Ok(Json(TripList {
        saved,
        shared_with_me,
        searches,
    }))
}

#[derive(Deserialize)]
struct CreateTrip {
    hash: String,
    route_idx: u32,
    name: String,
    max_distance: Option<f64>,
    #[serde(default)]
    blacklist: Vec<i64>,
}

#[derive(Serialize)]
struct CreatedTrip {
    id: String,
}

/// Also how a shared trip is copied: the client sends the blacklist it shows.
async fn create_trip(
    State(pool): State<DbPool>,
    auth: ClientAuth,
    Json(req): Json<CreateTrip>,
) -> Result<Json<CreatedTrip>, AppError> {
    let name = validate_trip_name(&req.name)?;
    validate_max_distance(req.max_distance)?;
    let mut conn = pool.get()?;

    // Only routes you can already open; knowing a hash isn't enough.
    require_route_access(&conn, &auth.username, &req.hash)?;
    let route = load_route(&conn, &req.hash)?.ok_or(AppError::FileNotFound)?;
    if route.summary(req.route_idx as usize).is_none() {
        return Err(AppError::FileNotFound);
    }

    let id = random_hex::<16>()?;
    let now = now();
    let tx = conn.transaction()?;
    tx.execute(
        "INSERT INTO trips (id, username, hash, route_idx, name, max_distance, created_at, last_used_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
        params![id, auth.username, req.hash, req.route_idx, name, req.max_distance, now],
    )?;
    {
        let mut stmt = tx.prepare(
            "INSERT OR IGNORE INTO trip_blacklist (trip_id, station_id) VALUES (?1, ?2)",
        )?;
        for station in &req.blacklist {
            stmt.execute(params![id, station])?;
        }
    }
    tx.commit()?;

    Ok(Json(CreatedTrip { id }))
}

#[derive(Serialize)]
struct Trip {
    id: String,
    name: String,
    hash: String,
    route_idx: u32,
    max_distance: Option<f64>,
    owned: bool,
    /// Display name of the owner.
    owner: String,
    blacklist: Vec<i64>,
}

async fn get_trip(
    State(pool): State<DbPool>,
    auth: ClientAuth,
    Path(id): Path<String>,
) -> Result<Json<Trip>, AppError> {
    let conn = pool.get()?;
    let access = trip_access(&conn, &id, &auth.username)?;
    if access == Access::Owner {
        conn.execute(
            "UPDATE trips SET last_used_at = ?2 WHERE id = ?1",
            params![id, now()],
        )?;
    }

    let blacklist = conn
        .prepare("SELECT station_id FROM trip_blacklist WHERE trip_id = ?1")?
        .query_map(params![id], |r| r.get(0))?
        .collect::<Result<_, _>>()?;

    let trip = conn.query_row(
        "SELECT t.id, t.name, t.hash, t.route_idx, t.max_distance,
            COALESCE(u.display_name, t.username)
         FROM trips t LEFT JOIN user_configs u ON u.username = t.username
         WHERE t.id = ?1",
        params![id],
        |r| {
            Ok(Trip {
                id: r.get(0)?,
                name: r.get(1)?,
                hash: r.get(2)?,
                route_idx: r.get(3)?,
                max_distance: r.get(4)?,
                owned: access == Access::Owner,
                owner: r.get(5)?,
                blacklist,
            })
        },
    )?;
    Ok(Json(trip))
}

#[derive(Deserialize)]
struct UpdateTrip {
    name: Option<String>,
    max_distance: Option<f64>,
}

async fn update_trip(
    State(pool): State<DbPool>,
    auth: ClientAuth,
    Path(id): Path<String>,
    Json(req): Json<UpdateTrip>,
) -> Result<StatusCode, AppError> {
    let conn = pool.get()?;
    require_owner(&conn, &id, &auth.username)?;
    let name = req.name.as_deref().map(validate_trip_name).transpose()?;
    validate_max_distance(req.max_distance)?;
    conn.execute(
        "UPDATE trips SET name = COALESCE(?2, name), max_distance = COALESCE(?3, max_distance)
         WHERE id = ?1",
        params![id, name, req.max_distance],
    )?;
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_trip(
    State(pool): State<DbPool>,
    auth: ClientAuth,
    Path(id): Path<String>,
) -> Result<StatusCode, AppError> {
    let conn = pool.get()?;
    require_owner(&conn, &id, &auth.username)?;
    let hash: String =
        conn.query_row("SELECT hash FROM trips WHERE id = ?1", params![id], |r| {
            r.get(0)
        })?;
    // The blacklist and share links go with it (ON DELETE CASCADE).
    conn.execute("DELETE FROM trips WHERE id = ?1", params![id])?;
    forget_route_if_unused(&conn, &hash)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn add_to_blacklist(
    State(pool): State<DbPool>,
    auth: ClientAuth,
    Path((id, station_id)): Path<(String, i64)>,
) -> Result<StatusCode, AppError> {
    let conn = pool.get()?;
    require_owner(&conn, &id, &auth.username)?;
    conn.execute(
        "INSERT OR IGNORE INTO trip_blacklist (trip_id, station_id) VALUES (?1, ?2)",
        params![id, station_id],
    )?;
    Ok(StatusCode::NO_CONTENT)
}

async fn remove_from_blacklist(
    State(pool): State<DbPool>,
    auth: ClientAuth,
    Path((id, station_id)): Path<(String, i64)>,
) -> Result<StatusCode, AppError> {
    let conn = pool.get()?;
    require_owner(&conn, &id, &auth.username)?;
    conn.execute(
        "DELETE FROM trip_blacklist WHERE trip_id = ?1 AND station_id = ?2",
        params![id, station_id],
    )?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize)]
struct NewShare {
    /// Path of the link (the client adds its origin). The only place the
    /// token ever appears.
    path: String,
    expires_at: i64,
}

async fn create_share(
    State(pool): State<DbPool>,
    auth: ClientAuth,
    Path(id): Path<String>,
) -> Result<Json<NewShare>, AppError> {
    let conn = pool.get()?;
    require_owner(&conn, &id, &auth.username)?;

    let token = random_hex::<32>()?;
    let created_at = now();
    let expires_at = created_at + SHARE_TTL_SECS;
    conn.execute(
        "INSERT INTO trip_shares (token_hash, trip_id, created_at, expires_at)
         VALUES (?1, ?2, ?3, ?4)",
        params![hash_token(&token), id, created_at, expires_at],
    )?;

    Ok(Json(NewShare {
        path: format!("/trips/claim/{token}"),
        expires_at,
    }))
}

#[derive(Serialize)]
struct Share {
    /// The token's hash: what revoking takes.
    id: String,
    created_at: i64,
    expires_at: i64,
    claimed_by: Option<String>,
    claimed_at: Option<i64>,
}

async fn list_shares(
    State(pool): State<DbPool>,
    auth: ClientAuth,
    Path(id): Path<String>,
) -> Result<Json<Vec<Share>>, AppError> {
    let conn = pool.get()?;
    require_owner(&conn, &id, &auth.username)?;
    // Unclaimed links that expired can't be used any more; leave them out.
    let shares = conn
        .prepare(
            "SELECT s.token_hash, s.created_at, s.expires_at,
                COALESCE(u.display_name, s.claimed_by), s.claimed_at
             FROM trip_shares s LEFT JOIN user_configs u ON u.username = s.claimed_by
             WHERE s.trip_id = ?1 AND (s.claimed_by IS NOT NULL OR s.expires_at > ?2)
             ORDER BY s.created_at DESC",
        )?
        .query_map(params![id, now()], |r| {
            Ok(Share {
                id: r.get(0)?,
                created_at: r.get(1)?,
                expires_at: r.get(2)?,
                claimed_by: r.get(3)?,
                claimed_at: r.get(4)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    Ok(Json(shares))
}

/// Cancels an unclaimed link, or takes access away from whoever claimed it.
async fn revoke_share(
    State(pool): State<DbPool>,
    auth: ClientAuth,
    Path((id, share_id)): Path<(String, String)>,
) -> Result<StatusCode, AppError> {
    let conn = pool.get()?;
    require_owner(&conn, &id, &auth.username)?;
    let deleted = conn.execute(
        "DELETE FROM trip_shares WHERE token_hash = ?1 AND trip_id = ?2",
        params![share_id, id],
    )?;
    if deleted == 0 {
        return Err(AppError::FileNotFound);
    }
    Ok(StatusCode::NO_CONTENT)
}

fn invalid_share() -> AppError {
    GenericSilentError::new(
        (
            StatusCode::NOT_FOUND,
            "This link is invalid, expired or has already been used",
        )
            .into_response(),
    )
    .into()
}

#[derive(Serialize)]
struct ClaimedTrip {
    trip_id: String,
    hash: String,
    route_idx: u32,
}

/// The first user to claim a link keeps it: they can open it again, nobody
/// else can. Opening your own trip's link doesn't use it up.
async fn claim_share(
    State(pool): State<DbPool>,
    auth: ClientAuth,
    Path(token): Path<String>,
) -> Result<Json<ClaimedTrip>, AppError> {
    // Cheap rejection of anything that can't be one of our tokens.
    if token.len() != 64 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(invalid_share());
    }
    let token_hash = hash_token(&token);
    let conn = pool.get()?;

    let (trip_id, owner, hash, route_idx): (String, String, String, u32) = conn
        .query_row(
            "SELECT t.id, t.username, t.hash, t.route_idx
             FROM trip_shares s JOIN trips t ON t.id = s.trip_id
             WHERE s.token_hash = ?1",
            params![token_hash],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?
        .ok_or_else(invalid_share)?;

    if owner != auth.username {
        // One statement, so two users claiming at once can't both win.
        let claimed = conn.execute(
            "UPDATE trip_shares SET claimed_by = ?2, claimed_at = COALESCE(claimed_at, ?3)
             WHERE token_hash = ?1
                AND ((claimed_by IS NULL AND expires_at > ?3) OR claimed_by = ?2)",
            params![token_hash, auth.username, now()],
        )?;
        if claimed == 0 {
            return Err(invalid_share());
        }
    }

    Ok(Json(ClaimedTrip {
        trip_id,
        hash,
        route_idx,
    }))
}

pub fn get_router() -> Router<DbPool> {
    Router::new()
        .route("/", get(list_trips).post(create_trip))
        .route("/claim/{token}", post(claim_share))
        .route(
            "/{id}",
            get(get_trip).patch(update_trip).delete(delete_trip),
        )
        .route(
            "/{id}/blacklist/{station_id}",
            put(add_to_blacklist).delete(remove_from_blacklist),
        )
        .route("/{id}/shares", get(list_shares).post(create_share))
        .route(
            "/{id}/shares/{share_id}",
            axum::routing::delete(revoke_share),
        )
}
