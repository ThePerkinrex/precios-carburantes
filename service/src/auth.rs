use std::sync::Arc;

use axum::{
    Extension,
    extract::{FromRef, FromRequestParts, Request, State},
    http::HeaderMap,
    middleware::Next,
    response::{IntoResponse, Response},
};
use rusqlite::params;
use time::OffsetDateTime;
use tracing::warn;

use crate::{
    DbPool,
    certs::{CertManager, normalize_serial},
    config::Config,
    error::AppError,
};

/// Who the request is from, as established by `auth_middleware` and stored
/// in the request extensions.
#[derive(Debug, Clone)]
struct Identity {
    username: String,
    label: String,
    /// `None` only for the dev fallback.
    serial: Option<String>,
    not_after: Option<OffsetDateTime>,
    /// Roles come from config for the dev fallback, from the DB otherwise.
    dev_roles: Option<Vec<String>>,
}

/// nginx verifies the client cert (chain + CRL) and passes the result and
/// the cert's serial. On top of that the serial must belong to a cert this
/// service issued or imported and still considers active — so a CRL that
/// nginx hasn't reloaded yet, or a cert signed by the CA some other way,
/// still doesn't get in.
async fn validate_auth(
    headers: &HeaderMap,
    config: &Config,
    certs: &CertManager,
) -> Result<Identity, AppError> {
    let verify_status = headers.get("X-SSL-Client-Verify");
    match (verify_status, &config.dev) {
        (Some(x), _) if x == "SUCCESS" => {
            let serial = headers
                .get("X-SSL-Client-Serial")
                .and_then(|v| v.to_str().ok())
                .ok_or(AppError::Auth)?;
            match certs.lookup(serial).await {
                Some(cert) if cert.is_active() => Ok(Identity {
                    username: cert.cn,
                    label: cert.label,
                    serial: Some(normalize_serial(serial)),
                    not_after: Some(cert.not_after),
                    dev_roles: None,
                }),
                Some(cert) => {
                    warn!("Rejected inactive cert {serial} of {}", cert.cn);
                    Err(AppError::Auth)
                }
                None => {
                    warn!("Rejected unknown cert {serial}");
                    Err(AppError::Auth)
                }
            }
        }
        (None, Some(dev)) => Ok(Identity {
            username: dev.user.clone(),
            label: "dev".to_string(),
            serial: None,
            not_after: None,
            dev_roles: Some(dev.roles.clone()),
        }),
        _ => Err(AppError::Auth),
    }
}

pub async fn auth_middleware(
    Extension(config): Extension<Arc<Config>>,
    Extension(certs): Extension<Arc<CertManager>>,
    mut request: Request,
    next: Next,
) -> Response {
    match validate_auth(request.headers(), &config, &certs).await {
        Ok(identity) => {
            request.extensions_mut().insert(identity);
            next.run(request).await
        }
        Err(x) => x.into_response(),
    }
}

pub const ADMIN_USERS_ROLE: &str = "admin_users";

pub struct ClientAuth {
    pub username: String,
    pub roles: Vec<String>,
    /// Device label of the cert used for this request.
    pub label: String,
    /// Serial of the cert used for this request; `None` in dev mode.
    pub serial: Option<String>,
    pub not_after: Option<OffsetDateTime>,
}

impl ClientAuth {
    pub fn has_role(&self, role: &str) -> bool {
        self.roles.iter().any(|x| x == role)
    }

    pub fn require_role(&self, role: &str) -> Result<(), AppError> {
        if self.has_role(role) {
            Ok(())
        } else {
            Err(AppError::Forbidden)
        }
    }
}

impl<S> FromRequestParts<S> for ClientAuth
where
    S: Send + Sync,
    DbPool: FromRef<S>,
{
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut axum::http::request::Parts,
        state: &S,
    ) -> Result<Self, Self::Rejection> {
        // Set by auth_middleware; missing means the route isn't behind it.
        let identity = parts
            .extensions
            .get::<Identity>()
            .cloned()
            .ok_or(AppError::Auth)?;

        let roles = match identity.dev_roles {
            Some(roles) => roles,
            None => {
                let State(pool) = State::<DbPool>::from_request_parts(parts, state).await?;
                let conn = pool.get()?;
                let mut stmt = conn.prepare("SELECT role FROM user_roles WHERE username = ?")?;
                stmt.query_map(params![identity.username], |r| r.get(0))?
                    .collect::<Result<Vec<String>, _>>()?
            }
        };

        Ok(Self {
            username: identity.username,
            roles,
            label: identity.label,
            serial: identity.serial,
            not_after: identity.not_after,
        })
    }
}
