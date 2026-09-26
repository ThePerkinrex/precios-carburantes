use std::{collections::HashMap, sync::Arc};

use axum::{
    Extension, Json, Router,
    extract::{Path, State},
    http::StatusCode,
    routing::{delete, get, post},
};
use rcgen::RevocationReason;
use serde::{Deserialize, Serialize};

use crate::{
    DbPool,
    auth::{ADMIN_USERS_ROLE, ClientAuth},
    certs::{CertManager, CertStatus, CertSummary},
    config::Config,
    enroll::{self, PendingInvite},
    error::AppError,
};

/// A cert as shown in the admin panel and the "my devices" list.
#[derive(Serialize)]
pub struct CertInfo {
    serial: String,
    label: String,
    issued_at: i64,
    not_after: i64,
    /// "active", "expired" or "revoked".
    status: &'static str,
    revoked_at: Option<i64>,
}

impl From<CertSummary> for CertInfo {
    fn from(c: CertSummary) -> Self {
        let (status, revoked_at) = match c.status {
            CertStatus::Revoked { at, .. } => ("revoked", Some(at.unix_timestamp())),
            CertStatus::Active if c.not_after <= time::OffsetDateTime::now_utc() => {
                ("expired", None)
            }
            CertStatus::Active => ("active", None),
        };
        Self {
            serial: c.serial,
            label: c.label,
            issued_at: c.issued_at.unix_timestamp(),
            not_after: c.not_after.unix_timestamp(),
            status,
            revoked_at,
        }
    }
}

/// Parses the reason names the frontend sends; anything else is `Unspecified`.
pub fn parse_reason(reason: Option<&str>) -> RevocationReason {
    match reason {
        Some("key_compromise") => RevocationReason::KeyCompromise,
        Some("superseded") => RevocationReason::Superseded,
        Some("cessation_of_operation") => RevocationReason::CessationOfOperation,
        Some("privilege_withdrawn") => RevocationReason::PrivilegeWithdrawn,
        _ => RevocationReason::Unspecified,
    }
}

#[derive(Serialize)]
struct UserInfo {
    cn: String,
    roles: Vec<String>,
    certs: Vec<CertInfo>,
}

async fn list_users(
    State(pool): State<DbPool>,
    Extension(certs): Extension<Arc<CertManager>>,
    auth: ClientAuth,
) -> Result<Json<Vec<UserInfo>>, AppError> {
    auth.require_role(ADMIN_USERS_ROLE)?;

    let mut roles: HashMap<String, Vec<String>> = HashMap::new();
    {
        let conn = pool.get()?;
        let mut stmt = conn.prepare("SELECT username, role FROM user_roles")?;
        for row in stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))? {
            let (user, role): (String, String) = row?;
            roles.entry(user).or_default().push(role);
        }
    }

    Ok(Json(
        certs
            .list_users()
            .await
            .into_iter()
            .map(|u| UserInfo {
                roles: roles.remove(&u.cn).unwrap_or_default(),
                cn: u.cn,
                certs: u.certs.into_iter().map(CertInfo::from).collect(),
            })
            .collect(),
    ))
}

#[derive(Deserialize)]
struct NewInvite {
    cn: String,
    label: String,
    /// Also grant the admin role (for bootstrapping another admin).
    #[serde(default)]
    admin: bool,
}

#[derive(Serialize)]
struct InviteCreated {
    url: String,
    expires_at: i64,
}

async fn create_invite(
    State(pool): State<DbPool>,
    Extension(certs): Extension<Arc<CertManager>>,
    Extension(config): Extension<Arc<Config>>,
    auth: ClientAuth,
    Json(params): Json<NewInvite>,
) -> Result<Json<InviteCreated>, AppError> {
    auth.require_role(ADMIN_USERS_ROLE)?;
    certs.check_label_free(&params.cn, &params.label, None).await?;

    let conn = pool.get()?;
    let invite = enroll::create_invite(&conn, &config, &params.cn, &params.label, &auth.username)?;
    if params.admin {
        conn.execute(
            "INSERT OR IGNORE INTO user_roles (username, role) VALUES (?1, ?2)",
            rusqlite::params![params.cn, ADMIN_USERS_ROLE],
        )?;
    }

    Ok(Json(InviteCreated {
        url: invite.url,
        expires_at: invite.expires_at,
    }))
}

async fn list_invites(
    State(pool): State<DbPool>,
    auth: ClientAuth,
) -> Result<Json<Vec<PendingInvite>>, AppError> {
    auth.require_role(ADMIN_USERS_ROLE)?;
    let conn = pool.get()?;
    Ok(Json(enroll::pending_invites(&conn)?))
}

async fn cancel_invite(
    State(pool): State<DbPool>,
    auth: ClientAuth,
    Path(id): Path<String>,
) -> Result<StatusCode, AppError> {
    auth.require_role(ADMIN_USERS_ROLE)?;
    let conn = pool.get()?;
    if enroll::cancel_invite(&conn, &id)? {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(AppError::FileNotFound)
    }
}

#[derive(Deserialize, Default)]
pub struct RevokeParams {
    pub reason: Option<String>,
}

async fn revoke_cert(
    Extension(certs): Extension<Arc<CertManager>>,
    auth: ClientAuth,
    Path(serial): Path<String>,
    params: Option<Json<RevokeParams>>,
) -> Result<StatusCode, AppError> {
    auth.require_role(ADMIN_USERS_ROLE)?;
    let Json(params) = params.unwrap_or_default();
    certs
        .revoke_cert(&serial, parse_reason(params.reason.as_deref()))
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub fn get_router() -> Router<DbPool> {
    Router::new()
        .route("/users", get(list_users))
        .route("/invites", get(list_invites).post(create_invite))
        .route("/invites/{id}", delete(cancel_invite))
        .route("/certs/{serial}/revoke", post(revoke_cert))
}
