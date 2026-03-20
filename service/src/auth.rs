use std::sync::Arc;

use axum::{
    Extension,
    extract::{FromRef, FromRequestParts, Request, State},
    http::{HeaderMap, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use rusqlite::params;
use tracing::warn;

use crate::{
    DbPool,
    config::{Config, DevConfig},
};

fn validate_auth<'a>(
    headers: &HeaderMap,
    config: &'a Config,
) -> Result<Option<&'a DevConfig>, (StatusCode, &'static str)> {
    let verify_status = headers.get("X-SSL-Client-Verify");
    match (verify_status, &config.dev) {
        (Some(x), _) if x == "SUCCESS" => Ok(None),
        (None, Some(dev)) => Ok(Some(dev)),
        _ => Err((
            StatusCode::UNAUTHORIZED,
            "Valid client certificate required",
        )),
    }
    // if verify_status.map(|v| v != "SUCCESS").unwrap_or_else(|| config.dev.is_none()) { // Pass if dev config is setup
    //     Err((
    //         StatusCode::UNAUTHORIZED,
    //         "Valid client certificate required",
    //     ))
    // } else {
    //     Ok()
    // }
}

pub async fn auth_middleware(
    Extension(config): Extension<Arc<Config>>,
    request: Request,
    next: Next,
) -> Response {
    // do something with `request`...

    if let Err(x) = validate_auth(request.headers(), &config) {
        x.into_response()
    } else {
        next.run(request).await
    }
}

pub const ADMIN_USERS_ROLE: &str = "admin_users";

pub struct ClientAuth {
    pub username: String,
    pub roles: Vec<String>,
}

impl ClientAuth {
    pub fn has_role(&self, role: &str) -> bool {
        self.roles.iter().any(|x| x == role)
    }
}

impl<S> FromRequestParts<S> for ClientAuth
where
    S: Send + Sync,
    DbPool: FromRef<S>,
{
    type Rejection = Response;

    async fn from_request_parts(
        parts: &mut axum::http::request::Parts,
        state: &S,
    ) -> Result<Self, Self::Rejection> {
        let Extension(config) = Extension::<Arc<Config>>::from_request_parts(parts, state)
            .await
            .map_err(IntoResponse::into_response)?;
        let State(pool) = State::<DbPool>::from_request_parts(parts, state)
            .await
            .map_err(IntoResponse::into_response)?;
        // 1. Check if Nginx verified the cert
        let dev_config =
            validate_auth(&parts.headers, &config).map_err(IntoResponse::into_response)?;

        if let Some(dev_config) = dev_config {
            Ok(Self {
                username: dev_config.user.clone(),
                roles: dev_config.roles.clone(),
            })
        } else {
            // 2. Extract the Distinguished Name (DN)
            let dn = parts
                .headers
                .get("X-SSL-Client-S-DN")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("");

            // Simple parse: extract CN=...
            let username = dn
                .split(',')
                .find(|s| s.trim().starts_with("CN="))
                .map(|s| s.replace("CN=", ""))
                .unwrap_or_else(|| "Unknown".to_string());

            let mut roles = Vec::new();
            {
                let conn = pool.get().map_err(|e| {
                    warn!("SQL Error: {e}");
                    StatusCode::INTERNAL_SERVER_ERROR.into_response()
                })?;
                let mut stmt = conn
                    .prepare("SELECT role FROM user_roles WHERE username = ?")
                    .map_err(|e| {
                        warn!("SQL Error: {e}");
                        StatusCode::INTERNAL_SERVER_ERROR.into_response()
                    })?;
                let result = stmt
                    .query_map(params![username], |r| r.get(0))
                    .map_err(|e| {
                        warn!("SQL Error: {e}");
                        StatusCode::INTERNAL_SERVER_ERROR.into_response()
                    })?;

                for role in result {
                    roles.push(role.map_err(|e| {
                        warn!("SQL Error: {e}");
                        StatusCode::INTERNAL_SERVER_ERROR.into_response()
                    })?);
                }
            }

            Ok(Self { username, roles })
        }
    }
}
