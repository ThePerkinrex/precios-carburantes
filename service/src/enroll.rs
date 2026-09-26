//! One-time invite links for getting a client cert without having one.
//!
//! An admin (or the `service invite` CLI) creates an invite for a CN + device
//! label. The link carries a random token; only its hash is stored. Opening
//! the link shows a page where the user picks a password, and submitting it
//! claims the token and downloads a freshly issued `.p12`.
//!
//! These are the only routes reachable without a client cert (nginx lets
//! `/enroll/` through with `ssl_verify_client optional`), so they're mounted
//! outside `auth_middleware` and expose nothing but token redemption.

use std::{borrow::Cow, sync::Arc};

use axum::{
    Extension, Form, Json, Router,
    extract::{Path, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha3::{Digest, Sha3_256};
use time::OffsetDateTime;
use tracing::info;

use crate::{
    DbPool,
    certs::{CertManager, validate_name},
    config::Config,
    error::{AppError, GenericSilentError},
    files::load_file_hidden,
};

const MIN_PASSWORD_LEN: usize = 6;
const MAX_PASSWORD_LEN: usize = 128;

pub(crate) fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// `N` random bytes, hex encoded: for tokens and unguessable ids.
pub(crate) fn random_hex<const N: usize>() -> Result<String, AppError> {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes)
        .map_err(|e| AppError::IO(std::io::Error::other(format!("getrandom failed: {e}"))))?;
    Ok(hex(&bytes))
}

pub(crate) fn hash_token(token: &str) -> String {
    hex(&Sha3_256::digest(token.as_bytes()))
}

pub(crate) fn now() -> i64 {
    OffsetDateTime::now_utc().unix_timestamp()
}

fn invalid_invite() -> AppError {
    GenericSilentError::new(
        (
            StatusCode::NOT_FOUND,
            "This invite link is invalid, expired or has already been used",
        )
            .into_response(),
    )
    .into()
}

pub struct Invite {
    pub url: String,
    pub expires_at: i64,
}

/// Stores a new invite and returns its link. The token itself is only ever
/// in the returned URL.
pub fn create_invite(
    conn: &Connection,
    config: &Config,
    cn: &str,
    label: &str,
    created_by: &str,
) -> Result<Invite, AppError> {
    validate_name(cn)?;
    validate_name(label)?;

    let token = random_hex::<32>()?;

    let created_at = now();
    let expires_at = created_at + i64::from(config.certs.invite_ttl_hours) * 3600;
    conn.execute(
        "INSERT INTO enrollments (token_hash, cn, label, created_by, created_at, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            hash_token(&token),
            cn,
            label,
            created_by,
            created_at,
            expires_at
        ],
    )?;
    info!("{created_by} created an invite for {cn}/{label}");

    Ok(Invite {
        url: format!("{}/enroll/{token}", config.public_url.trim_end_matches('/')),
        expires_at,
    })
}

#[derive(Serialize)]
pub struct PendingInvite {
    /// The token hash — safe to show, and what cancellation takes.
    pub id: String,
    pub cn: String,
    pub label: String,
    pub created_by: String,
    pub created_at: i64,
    pub expires_at: i64,
}

pub fn pending_invites(conn: &Connection) -> rusqlite::Result<Vec<PendingInvite>> {
    let mut stmt = conn.prepare(
        "SELECT token_hash, cn, label, created_by, created_at, expires_at FROM enrollments
         WHERE used_at IS NULL AND expires_at > ?1
         ORDER BY created_at DESC",
    )?;
    stmt.query_map(params![now()], |r| {
        Ok(PendingInvite {
            id: r.get(0)?,
            cn: r.get(1)?,
            label: r.get(2)?,
            created_by: r.get(3)?,
            created_at: r.get(4)?,
            expires_at: r.get(5)?,
        })
    })?
    .collect()
}

/// Deletes an unused invite. Returns whether one was removed.
pub fn cancel_invite(conn: &Connection, id: &str) -> rusqlite::Result<bool> {
    Ok(conn.execute(
        "DELETE FROM enrollments WHERE token_hash = ?1 AND used_at IS NULL",
        params![id],
    )? == 1)
}

/// The (cn, label) of a still-redeemable invite.
fn open_invite(conn: &Connection, token: &str) -> Result<(String, String), AppError> {
    // Cheap rejection of anything that can't be one of our tokens.
    if token.len() != 64 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(invalid_invite());
    }
    conn.query_row(
        "SELECT cn, label FROM enrollments
         WHERE token_hash = ?1 AND used_at IS NULL AND expires_at > ?2",
        params![hash_token(token), now()],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()?
    .ok_or_else(invalid_invite)
}

/// Checks a user-chosen P12 password from a form.
pub fn check_password(password: &str, repeated: &str) -> Result<(), AppError> {
    if password != repeated {
        return Err(AppError::BadRequest("Passwords don't match".into()));
    }
    if !(MIN_PASSWORD_LEN..=MAX_PASSWORD_LEN).contains(&password.chars().count()) {
        return Err(AppError::BadRequest(Cow::Owned(format!(
            "Password must be {MIN_PASSWORD_LEN}-{MAX_PASSWORD_LEN} characters"
        ))));
    }
    Ok(())
}

/// A `.p12` as a file download.
pub fn p12_response(label: &str, p12: Vec<u8>) -> Response {
    (
        [
            (header::CONTENT_TYPE, "application/x-pkcs12".to_string()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"carburantes-{label}.p12\""),
            ),
            (header::CACHE_CONTROL, "no-store".to_string()),
        ],
        p12,
    )
        .into_response()
}

async fn enroll_page(Path(_token): Path<String>) -> Result<Response, AppError> {
    load_file_hidden("enroll").await
}

#[derive(Serialize)]
struct InviteInfo {
    cn: String,
    label: String,
}

async fn invite_info(
    State(pool): State<DbPool>,
    Path(token): Path<String>,
) -> Result<Json<InviteInfo>, AppError> {
    let conn = pool.get()?;
    let (cn, label) = open_invite(&conn, &token)?;
    Ok(Json(InviteInfo { cn, label }))
}

#[derive(Deserialize)]
struct RedeemForm {
    password: String,
    password2: String,
}

async fn redeem(
    State(pool): State<DbPool>,
    Extension(certs): Extension<Arc<CertManager>>,
    Path(token): Path<String>,
    Form(form): Form<RedeemForm>,
) -> Result<Response, AppError> {
    check_password(&form.password, &form.password2)?;

    let conn = pool.get()?;
    let (cn, label) = open_invite(&conn, &token)?;
    // Fail before burning the token if the label got taken since the invite.
    certs.check_label_free(&cn, &label, None).await?;

    // Claim atomically: a concurrent second redemption affects 0 rows.
    let token_hash = hash_token(&token);
    let claimed = conn.execute(
        "UPDATE enrollments SET used_at = ?2
         WHERE token_hash = ?1 AND used_at IS NULL AND expires_at > ?2",
        params![token_hash, now()],
    )?;
    if claimed != 1 {
        return Err(invalid_invite());
    }

    let issued = match certs.issue_p12(&cn, &label, None, &form.password).await {
        Ok(issued) => issued,
        Err(e) => {
            // Nothing was issued, so give the link back.
            conn.execute(
                "UPDATE enrollments SET used_at = NULL WHERE token_hash = ?1",
                params![token_hash],
            )?;
            return Err(e.into());
        }
    };
    conn.execute(
        "UPDATE enrollments SET used_serial = ?2 WHERE token_hash = ?1",
        params![token_hash, issued.serial],
    )?;

    Ok(p12_response(&label, issued.p12))
}

pub fn get_router() -> Router<DbPool> {
    Router::new()
        .route("/{token}", get(enroll_page).post(redeem))
        .route("/{token}/info", get(invite_info))
}
