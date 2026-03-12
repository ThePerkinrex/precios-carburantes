use std::sync::Arc;

use axum::{
    Extension, extract::{FromRequestParts, Request},
    http::{HeaderMap, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};

use crate::config::Config;

fn validate_auth<'a>(
    headers: &HeaderMap,
    config: &'a Config,
) -> Result<Option<&'a String>, (StatusCode, &'static str)> {
    let verify_status = headers.get("X-SSL-Client-Verify");
    match (verify_status, &config.dev) {
        (Some(x), _) if x == "SUCCESS" => Ok(None),
        (None, Some(dev)) => Ok(Some(&dev.user)),
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

pub struct ClientAuth {
    pub username: String,
}

impl<S> FromRequestParts<S> for ClientAuth
where
    S: Send + Sync,
{
    type Rejection = Response;

    async fn from_request_parts(
        parts: &mut axum::http::request::Parts,
        state: &S,
    ) -> Result<Self, Self::Rejection> {
        let Extension(config) = Extension::<Arc<Config>>::from_request_parts(parts, state)
            .await
            .map_err(IntoResponse::into_response)?;
        // 1. Check if Nginx verified the cert
        let dev_user =
            validate_auth(&parts.headers, &config).map_err(IntoResponse::into_response)?;

        if let Some(dev_user) = dev_user.cloned() {
            Ok(Self {
                username: dev_user,
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

            Ok(Self { username })
        }
    }
}
