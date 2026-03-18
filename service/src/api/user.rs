use axum::{Json, Router, extract::State, http::StatusCode, routing::{get, put}};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use tracing::warn;

use crate::{DbPool, auth::ClientAuth};

#[derive(Debug, Serialize)]
pub struct UserState {
    username: String,
    display_name: String,
    filter: String,
}

fn get_user_state(conn: &Connection, username: &str) -> rusqlite::Result<UserState> {
    conn.query_row(
        "
        SELECT
            username,
            display_name,
            last_filter
        FROM user_configs
        WHERE username = ?1

        UNION ALL

        SELECT
            ?1 AS username,
            ?1 AS display_name,
            'all' AS last_filter
        WHERE NOT EXISTS (
            SELECT 1 FROM user_configs WHERE username = ?1
        )
        LIMIT 1
        ",
        params![username],
        |row| {
            Ok(UserState {
                username: row.get(0)?,
                display_name: row.get(1)?,
                filter: row.get(2)?,
            })
        },
    )
}

fn update_user_filter(conn: &Connection, username: &str, new_filter: &str) -> rusqlite::Result<()> {
    conn.execute(
        "
        INSERT INTO user_configs (username, display_name, last_filter)
        VALUES (?1, ?1, ?2)
        ON CONFLICT(username) DO UPDATE
        SET last_filter = excluded.last_filter
        ",
        params![username, new_filter],
    )?;

    Ok(())
}

fn update_user_display_name(
    conn: &Connection,
    username: &str,
    display_name: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "
        INSERT INTO user_configs (username, display_name, last_filter)
        VALUES (?1, ?2, 'all')
        ON CONFLICT(username) DO UPDATE
        SET display_name = excluded.display_name
        ",
        params![username, display_name],
    )?;

    Ok(())
}

async fn user_state(
    State(pool): State<DbPool>,
    auth: ClientAuth,
) -> Result<Json<UserState>, StatusCode> {
    let conn = pool.get().map_err(|e| {
        warn!("Pool error: {e}");
        StatusCode::INTERNAL_SERVER_ERROR
    })?;
    get_user_state(&conn, &auth.username)
        .map_err(|e| {
            warn!("Get state error: {e}");
            StatusCode::INTERNAL_SERVER_ERROR
        })
        .map(Json)
}

#[derive(Debug, Deserialize)]
struct PutDisplayName {
    display_name: String
}

async fn set_user_display_name(
    State(pool): State<DbPool>,
    auth: ClientAuth,
    Json(params): Json<PutDisplayName>
) -> Result<StatusCode, StatusCode> {
    let conn = pool.get().map_err(|e| {
        warn!("Pool error: {e}");
        StatusCode::INTERNAL_SERVER_ERROR
    })?;
    update_user_display_name(&conn, &auth.username, &params.display_name)
        .map_err(|e| {
            warn!("Get state error: {e}");
            StatusCode::INTERNAL_SERVER_ERROR
        })?;
    Ok(StatusCode::OK)
}

#[derive(Debug, Deserialize)]
struct PutFilter {
    filter: String
}

async fn set_filter(
    State(pool): State<DbPool>,
    auth: ClientAuth,
    Json(params): Json<PutFilter>
) -> Result<StatusCode, StatusCode> {
    let conn = pool.get().map_err(|e| {
        warn!("Pool error: {e}");
        StatusCode::INTERNAL_SERVER_ERROR
    })?;
    update_user_filter(&conn, &auth.username, &params.filter)
        .map_err(|e| {
            warn!("Get state error: {e}");
            StatusCode::INTERNAL_SERVER_ERROR
        })?;
    Ok(StatusCode::OK)
}

pub fn get_router() -> Router<DbPool> {
    Router::new()
        .route("/state", get(user_state))
        .route("/name/diplay", put(set_user_display_name))
        .route("/filter", put(set_filter))
}
