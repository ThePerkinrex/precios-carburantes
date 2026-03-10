use axum::Router;
use database_access::{DEFAULT_DB_PATH, get_connection_manager};
use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use tracing::{info, level_filters::LevelFilter};
use tracing_subscriber::EnvFilter;

type DbPool = Pool<SqliteConnectionManager>;

mod api;

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

    info!("Starting up process service");


    let manager = get_connection_manager(DEFAULT_DB_PATH).unwrap();
    let pool = r2d2::Pool::new(manager).unwrap();


    let app = Router::new().nest("/api", api::get_router()).with_state(pool);

    let addr = std::env::var("PRICE_ADDR").unwrap_or_else(|_| "0.0.0.0:8001".into());

    // run our app with hyper, listening globally on port 3000
    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    info!("Listening on {addr}");
    axum::serve(listener, app).await.unwrap();
}
