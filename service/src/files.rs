use std::path::{PathBuf};

use axum::{
    Router, extract::Path, response::Response, routing::get
};

use crate::{DbPool, error::AppError};

#[cfg(feature = "include-static")]
mod static_load;

#[cfg(feature = "include-static")]
use static_load as load;

#[cfg(not(feature = "include-static"))]
mod dynamic_load;

#[cfg(not(feature = "include-static"))]
use dynamic_load as load;


async fn file(Path(path): Path<PathBuf>) -> Result<Response, AppError> {
	// info!("!{}", path.display());
	// for e in PROJECT_DIR.entries() {
	// 	info!(" + {}", e.path().display())
	// }
	load::load_file(path).await
}

pub fn get_router() -> Router<DbPool> {
    Router::new().route("/{*path}", get(file))
}
