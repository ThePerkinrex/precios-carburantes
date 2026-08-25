use std::{borrow::Cow, convert::Infallible, sync::Arc};

use axum::{
    extract::{Request, rejection::ExtensionRejection},
    middleware::Next,
    response::{IntoResponse, Redirect, Response},
};
use reqwest::StatusCode;
use thiserror::Error;

use crate::{api::route::RouteError, not_found};

#[derive(Debug, Error)]
pub struct GenericLoggedError {
    pub response: Box<Response>,
    pub message: Cow<'static, str>,
}

impl GenericLoggedError {
    pub fn new(response: Response, message: Cow<'static, str>) -> Self {
        Self {
            response: Box::new(response),
            message,
        }
    }
}

impl std::fmt::Display for GenericLoggedError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "GenericLoggedError: Status {} | {}",
            self.response.status(),
            self.message
        )
    }
}

#[derive(Debug, Error)]
pub struct GenericSilentError {
    pub response: Box<Response>,
}

impl GenericSilentError {
    pub fn new(response: Response) -> Self {
        Self {
            response: Box::new(response),
        }
    }
}

impl std::fmt::Display for GenericSilentError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "GenericSilentError: Status {}", self.response.status())
    }
}

#[derive(Debug, Error)]
pub enum AppError {
    #[error(transparent)]
    GenericLogged(#[from] GenericLoggedError),
    #[error(transparent)]
    GenericSilent(#[from] GenericSilentError),
    #[error(transparent)]
    SqlError(#[from] rusqlite::Error),
    #[error(transparent)]
    R2D2Error(#[from] r2d2::Error),
    #[error("Auth Error")]
    Auth,
    #[error(transparent)]
    Extension(#[from] ExtensionRejection),
    #[error(transparent)]
    IO(#[from] std::io::Error),
    #[error("File not found")]
    FileNotFound,
    #[error(transparent)]
    Route(#[from] RouteError),
    #[error("Redirect {0:?}")]
    Redirect(Redirect),
}

impl From<Redirect> for AppError {
    fn from(value: Redirect) -> Self {
        Self::Redirect(value)
    }
}

impl From<Infallible> for AppError {
    fn from(_: Infallible) -> Self {
        unreachable!()
    }
}

#[derive(Clone)]
struct LogErrorExtension(Arc<Cow<'static, str>>);

#[derive(Clone)]
struct LogDebugExtension(Arc<Cow<'static, str>>);

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (mut resp, msg) = match self {
            Self::GenericLogged(generic_logged_error) => (
                *generic_logged_error.response,
                Some(generic_logged_error.message),
            ),
            Self::GenericSilent(generic_silent_error) => (*generic_silent_error.response, None),
            Self::SqlError(e) => (
                StatusCode::INTERNAL_SERVER_ERROR.into_response(),
                Some(format!("SQL Error: {e}").into()),
            ),
            Self::Auth => (
                (
                    StatusCode::UNAUTHORIZED,
                    "Valid client certificate required",
                )
                    .into_response(),
                None,
            ),
            Self::Extension(rejection) => {
                let msg = format!("Extension Rejection: {rejection}");
                (rejection.into_response(), Some(msg.into()))
            }
            Self::R2D2Error(e) => (
                StatusCode::INTERNAL_SERVER_ERROR.into_response(),
                Some(format!("R2D2 Error: {e}").into()),
            ),
            Self::IO(e) => (
                StatusCode::INTERNAL_SERVER_ERROR.into_response(),
                Some(format!("IO Error: {e}").into()),
            ),
            Self::FileNotFound => {
                let mut resp = tokio::task::block_in_place(move || {
                    tokio::runtime::Handle::current().block_on(not_found())
                })
                .into_response();
                resp.extensions_mut()
                    .insert(LogDebugExtension(Arc::new("File Not Found".into())));
                (resp, None)
            }
            Self::Route(e) => (
                StatusCode::INTERNAL_SERVER_ERROR.into_response(),
                Some(format!("Route Error: {e}").into()),
            ),
            Self::Redirect(r) => (r.into_response(), None),
        };

        if let Some(msg) = msg {
            resp.extensions_mut()
                .insert(LogErrorExtension(Arc::new(msg)));
        }
        resp
    }
}

pub async fn log_app_errors(request: Request, next: Next) -> Response {
    let uri = request.uri().clone();
    let method = request.method().clone();
    let response = next.run(request).await;

    // Check if the response was "stamped" with a log message
    if let Some(error_ext) = response.extensions().get::<LogErrorExtension>() {
        tracing::error!(
            method = %method, uri = %uri,
            "Handler error: {}", error_ext.0
        );
    }

    if let Some(error_ext) = response.extensions().get::<LogDebugExtension>() {
        tracing::debug!(
            method = %method, uri = %uri,
            "Handler debug: {}", error_ext.0
        );
    }

    response
}
