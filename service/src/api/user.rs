use std::sync::Arc;

use axum::{
    Extension, Form, Json, Router,
    extract::{Path, State},
    http::StatusCode,
    response::Response,
    routing::{get, post, put},
};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};

use crate::{
    DbPool,
    api::admin::{CertInfo, RevokeParams, parse_reason},
    auth::ClientAuth,
    certs::{CertManager, normalize_serial},
    enroll::{check_password, p12_response},
    error::AppError,
};

#[derive(Debug, Serialize)]
pub struct UserState {
    username: String,
    display_name: String,
    filter: String,
    roles: Vec<String>,
    /// The cert this request came in with; `None` in dev mode.
    cert: Option<CurrentCert>,
}

#[derive(Debug, Serialize)]
struct CurrentCert {
    label: String,
    serial: String,
    not_after: i64,
}

fn get_user_state(
    conn: &Connection,
    username: &str,
    roles: Vec<String>,
) -> rusqlite::Result<UserState> {
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
                roles,
                cert: None,
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
) -> Result<Json<UserState>, AppError> {
    let conn = pool.get()?;
    let mut state = get_user_state(&conn, &auth.username, auth.roles.clone())?;
    state.cert = auth
        .serial
        .zip(auth.not_after)
        .map(|(serial, not_after)| CurrentCert {
            label: auth.label,
            serial,
            not_after: not_after.unix_timestamp(),
        });
    Ok(Json(state))
}

#[derive(Debug, Deserialize)]
struct PutDisplayName {
    display_name: String,
}

async fn set_user_display_name(
    State(pool): State<DbPool>,
    auth: ClientAuth,
    Json(params): Json<PutDisplayName>,
) -> Result<StatusCode, AppError> {
    let conn = pool.get()?;
    update_user_display_name(&conn, &auth.username, &params.display_name)?;
    Ok(StatusCode::OK)
}

#[derive(Debug, Deserialize)]
struct PutFilter {
    filter: String,
}

async fn set_filter(
    State(pool): State<DbPool>,
    auth: ClientAuth,
    Json(params): Json<PutFilter>,
) -> Result<StatusCode, AppError> {
    let conn = pool.get()?;
    update_user_filter(&conn, &auth.username, &params.filter)?;
    Ok(StatusCode::OK)
}

#[derive(Serialize)]
struct MyCert {
    #[serde(flatten)]
    cert: CertInfo,
    /// The cert this request came in with.
    current: bool,
}

async fn my_certs(
    Extension(certs): Extension<Arc<CertManager>>,
    auth: ClientAuth,
) -> Json<Vec<MyCert>> {
    Json(
        certs
            .certs_for(&auth.username)
            .await
            .into_iter()
            .map(|c| MyCert {
                current: auth.serial.as_deref() == Some(c.serial.as_str()),
                cert: CertInfo::from(c),
            })
            .collect(),
    )
}

/// Revoke one of your own devices (e.g. a lost phone).
async fn revoke_my_cert(
    Extension(certs): Extension<Arc<CertManager>>,
    auth: ClientAuth,
    Path(serial): Path<String>,
    params: Option<Json<RevokeParams>>,
) -> Result<StatusCode, AppError> {
    let serial = normalize_serial(&serial);
    match certs.lookup(&serial).await {
        Some(cert) if cert.cn == auth.username => {}
        // Same answer whether it doesn't exist or isn't yours.
        _ => return Err(AppError::FileNotFound),
    }
    let Json(params) = params.unwrap_or_default();
    certs
        .revoke_cert(&serial, parse_reason(params.reason.as_deref()))
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct RenewForm {
    password: String,
    password2: String,
    /// New label; defaults to the current cert's.
    label: Option<String>,
}

/// Issues a replacement for the cert this request came in with. The old one
/// stays valid until it expires, so a failed import can't lock anyone out.
async fn renew_cert(
    Extension(certs): Extension<Arc<CertManager>>,
    auth: ClientAuth,
    Form(form): Form<RenewForm>,
) -> Result<Response, AppError> {
    check_password(&form.password, &form.password2)?;
    let Some(serial) = auth.serial.as_deref() else {
        return Err(AppError::BadRequest("No client certificate to renew".into()));
    };
    let label = form
        .label
        .as_deref()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .unwrap_or(&auth.label);

    let issued = certs
        .issue_p12(&auth.username, label, Some(serial), &form.password)
        .await?;
    Ok(p12_response(label, issued.p12))
}

pub fn get_router() -> Router<DbPool> {
    Router::new()
        .route("/state", get(user_state))
        .route("/certs", get(my_certs))
        .route("/certs/{serial}/revoke", post(revoke_my_cert))
        .route("/cert/renew", post(renew_cert))
        .route("/name/display", put(set_user_display_name))
        .route("/filter", put(set_filter))
}
