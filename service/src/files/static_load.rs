use std::path::Path;

use axum::{body::Body, http::{StatusCode, header}, response::{IntoResponse, Response}};
use include_dir::{Dir, DirEntry, include_dir};

static PROJECT_DIR: Dir = include_dir!("$CARGO_MANIFEST_DIR/src/static");

fn match_entry(entry: Option<&DirEntry>) -> Result<Response, AppError> {
	// info!(">{entry:?}");
	match entry {
		None => Err(AppError::FileNotFound),
		Some(DirEntry::Dir(dir)) => match_entry(dir.get_entry(dir.path().join("index.html"))),
		Some(DirEntry::File(file)) => {
			let mime = mime_guess::from_path(file.path()).first_or_octet_stream();
			// tracing::info!("Guessing {mime} for {}", file.path().display());
			Ok((StatusCode::OK, [(header::CONTENT_TYPE, mime.essence_str())], file.contents().to_vec()).into_response())
		}
	}
}

pub async fn load_file<P: AsRef<Path>>(path: P) -> Result<Response, AppError> {
	// info!("!{}", path.display());
	// for e in PROJECT_DIR.entries() {
	// 	info!(" + {}", e.path().display())
	// }
	match_entry(PROJECT_DIR.get_entry(path))
}