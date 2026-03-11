use std::path::{PathBuf};

use axum::{
    Router,
    body::Body,
    extract::Path,
    http::Response,
    routing::get,
};

use crate::DbPool;

#[cfg(feature = "include-static")]
mod static_load;

#[cfg(feature = "include-static")]
use static_load as load;

#[cfg(not(feature = "include-static"))]
mod dynamic_load;

#[cfg(not(feature = "include-static"))]
use dynamic_load as load;


async fn file(Path(path): Path<PathBuf>) -> Response<Body> {
	// info!("!{}", path.display());
	// for e in PROJECT_DIR.entries() {
	// 	info!(" + {}", e.path().display())
	// }
	load::load_file(path).await
}

pub fn get_router() -> Router<DbPool> {
    Router::new().route("/{*path}", get(file))
}
