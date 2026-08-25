use std::path::Path;

use axum::{
    body::Body,
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use tracing::{debug, warn};

use crate::error::AppError;

const STATIC_FILE_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/src/static/visible");
const STATIC_HIDDEN_FILE_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/src/static/hidden");

async fn match_entry<P: AsRef<Path>>(path: P) -> Result<Response, AppError> {
    let path = path.as_ref();
    if path.exists() {
        if path.is_dir() {
            Box::pin(match_entry(path.join("index.html"))).await
        } else {
            debug!("Loading file dynamically: {}", path.display());
            let mime = mime_guess::from_path(path).first_or_octet_stream();
            Ok((
                StatusCode::OK,
                [(header::CONTENT_TYPE, mime.essence_str())],
                tokio::fs::read(path).await?,
            )
                .into_response())
        }
    } else {
        Err(AppError::FileNotFound)
    }
}

pub async fn load_file<P: AsRef<Path>>(path: P) -> Result<Response, AppError> {
    match_entry(Path::new(STATIC_FILE_PATH).join(path)).await
}

pub async fn load_file_hidden<P: AsRef<Path>>(path: P) -> Result<Response, AppError> {
    match_entry(Path::new(STATIC_HIDDEN_FILE_PATH).join(path)).await
}
