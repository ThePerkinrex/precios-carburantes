use std::{fs::File, sync::Arc};

use axum::{Extension, Router, middleware};
use database_access::{DEFAULT_DB_PATH, get_connection_manager};
use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use tracing::{info, level_filters::LevelFilter};
use tracing_subscriber::EnvFilter;

use crate::config::Config;

type DbPool = Pool<SqliteConnectionManager>;

mod api;
mod files;
mod config;
mod auth;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::builder()
                .with_default_directive(LevelFilter::INFO.into())
                .with_env_var("PRICE_LOG")
                .from_env_lossy(),
        )
        .init();

    info!("Features: {}", env!("BUILD_FEATURES"));

    let config: Config = serde_json::from_reader(File::open("service.config.json").unwrap()).unwrap();

    info!("Config: {config:#?}");

    info!("Starting up process service");

    let manager = get_connection_manager(DEFAULT_DB_PATH).unwrap();
    let pool = r2d2::Pool::new(manager).unwrap();


    let addr = config.addr.to_slice().to_vec();

    let app = Router::new()
        .nest("/api", api::get_router())
        .nest("/files", files::get_router())
        .layer(middleware::from_fn(auth::auth_middleware))
        .layer(Extension(Arc::new(config)))
        .with_state(pool);

    // let addr = std::env::var("PRICE_ADDR").unwrap_or_else(|_| "127.0.0.1:8001".into());

    // run our app with hyper, listening globally on port 3000
    let listener = tokio::net::TcpListener::bind(&*addr).await.unwrap();
    info!("Listening on {}", listener.local_addr().unwrap());
    axum::serve(listener, app).await.unwrap();
}
