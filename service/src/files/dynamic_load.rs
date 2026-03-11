use std::path::Path;

use axum::{body::Body, http::{StatusCode, header}, response::{AppendHeaders, IntoResponse, Response}};
use tracing::warn;

const STATIC_FILE_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/src/static/");

async fn match_entry<P: AsRef<Path>>(path: P) -> Result<Response<Body>, Response<Body>> {
	let path = path.as_ref();
	if path.exists() {
		if path.is_dir() {
			Box::pin(match_entry(path.join("index.html"))).await
		}else{
			let mime = mime_guess::from_path(path).first_or_octet_stream();
			Ok((StatusCode::OK, AppendHeaders([(header::CONTENT_TYPE, mime.essence_str())]), tokio::fs::read(path).await.map_err(|e| {
				warn!("Error reading file: {e}");
				StatusCode::INTERNAL_SERVER_ERROR.into_response()
			})?).into_response())
		}
	}else{
		Err(StatusCode::NOT_FOUND.into_response())
	}
}

pub async fn load_file<P: AsRef<Path>>(path: P) -> Response<Body> {
	match_entry(Path::new(STATIC_FILE_PATH).join(path)).await.unwrap_or_else(|e| e)
}