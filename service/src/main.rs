use std::{fs::File, sync::Arc};

use axum::{
    Extension, Router,
    extract::{Path, State},
    http::{HeaderMap, Uri, header},
    middleware,
    response::{Html, Redirect, Response},
    routing::get,
};
use database_access::{DEFAULT_DB_PATH, get_connection_manager};
use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use reqwest::StatusCode;
use tracing::{debug, info, level_filters::LevelFilter};
use tracing_subscriber::EnvFilter;

use crate::{
    api::route::get_route_from_db, config::Config, error::AppError, files::load_file_hidden,
};

type DbPool = Pool<SqliteConnectionManager>;

mod api;
mod auth;
mod config;
mod error;
mod files;

// fn wants_html(headers: &HeaderMap) -> bool {
//     debug!("WANTS HTML. Accept: {:?}", headers.get(header::ACCEPT));
//     headers
//         .get(header::ACCEPT)
//         .and_then(|v| v.to_str().ok())
//         .map(|v| v.contains("text/html"))
//         .unwrap_or(false)
// }

async fn get_route(
    State(pool): State<DbPool>,
    Path((hash, route_idx)): Path<(String, usize)>,
) -> Result<Response, AppError> {
    let data = get_route_from_db(pool, &hash)
        .await?
        .ok_or(AppError::FileNotFound)?;

    let _ = data.routes.get(route_idx).ok_or(AppError::FileNotFound)?;

    load_file_hidden("route").await
}

async fn not_found() -> Result<Response, AppError> {
    load_file_hidden("not_found.html").await.map(|mut r| {
        *r.status_mut() = StatusCode::NOT_FOUND;
        r
    })
}
#[tokio::main]
async fn main() {
    dotenvy::dotenv().unwrap();
    let filter = EnvFilter::builder()
        .with_default_directive(LevelFilter::INFO.into())
        .with_env_var("PRICE_LOG")
        .from_env_lossy();
    tracing_subscriber::fmt()
        .with_env_filter(filter.clone())
        .init();

    info!("EnvFilter: {}", filter);

    info!("Features: {}", env!("BUILD_FEATURES"));

    let config: Config =
        serde_json::from_reader(File::open("service.config.json").unwrap()).unwrap();

    info!("Config: {config:#?}");

    info!("Starting up process service");

    let manager = get_connection_manager(DEFAULT_DB_PATH).unwrap();
    let pool = r2d2::Pool::new(manager).unwrap();

    let addr = config.addr.to_slice().to_vec();

    let app = Router::new()
        .nest("/api", api::get_router())
        .nest("/files", files::get_router())
        .route("/", get(|| async { Redirect::to("/files/index.html") }))
        .route("/route/{hash}/{id}", get(get_route))
        .fallback(not_found)
        .layer(middleware::from_fn(auth::auth_middleware))
        .layer(middleware::from_fn(error::log_app_errors))
        .layer(Extension(Arc::new(config)))
        .with_state(pool);

    // let addr = std::env::var("PRICE_ADDR").unwrap_or_else(|_| "127.0.0.1:8001".into());

    // run our app with hyper, listening globally on port 3000
    let listener = tokio::net::TcpListener::bind(&*addr).await.unwrap();
    info!("Listening on {}", listener.local_addr().unwrap());
    axum::serve(listener, app).await.unwrap();
}
