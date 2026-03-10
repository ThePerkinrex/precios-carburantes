use std::path::{PathBuf};

use axum::{
    Router,
    body::Body,
    extract::Path,
    http::{Response, StatusCode, header},
    response::{AppendHeaders, IntoResponse},
    routing::get,
};
use include_dir::{Dir, DirEntry, include_dir};
use tracing::info;

use crate::DbPool;

static PROJECT_DIR: Dir = include_dir!("$CARGO_MANIFEST_DIR/src/static");

fn match_entry(entry: Option<&DirEntry>) -> Response<Body> {
	// info!(">{entry:?}");
	match entry {
		None => StatusCode::NOT_FOUND.into_response(),
		Some(DirEntry::Dir(dir)) => match_entry(dir.get_entry(dir.path().join("index.html"))),
		Some(DirEntry::File(file)) => {
			let mime = mime_guess::from_path(file.path()).first_or_octet_stream();
			(StatusCode::OK, AppendHeaders([(header::CONTENT_TYPE, mime.essence_str())]), file.contents().to_vec()).into_response()
		}
	}
}

async fn file(Path(path): Path<PathBuf>) -> Response<Body> {
	// info!("!{}", path.display());
	// for e in PROJECT_DIR.entries() {
	// 	info!(" + {}", e.path().display())
	// }
	match_entry(PROJECT_DIR.get_entry(&path))
}

pub fn get_router() -> Router<DbPool> {
    Router::new().route("/{*path}", get(file))
}
