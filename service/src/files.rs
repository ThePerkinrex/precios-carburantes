use axum::{
    Router,
    body::Body,
    extract::Path,
    http::{Response, StatusCode},
    response::IntoResponse,
    routing::get,
};
use include_dir::{Dir, DirEntry, include_dir};

use crate::DbPool;

static PROJECT_DIR: Dir = include_dir!("$CARGO_MANIFEST_DIR/src/static");

async fn file(Path(path): Path<String>) -> Response<Body> {
	match PROJECT_DIR.get_entry(path) {
		None => StatusCode::NOT_FOUND.into_response(),
		Some(DirEntry::Dir(dir)) => StatusCode::NOT_FOUND.into_response(),
		Some(DirEntry::File(file)) => {
			(StatusCode::OK, file.contents()).into_response()
		}
	}
}

pub fn get_router() -> Router<DbPool> {
    Router::new().route("/{*path}", get(file))
}
