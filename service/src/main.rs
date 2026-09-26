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
use tracing::{debug, info, level_filters::LevelFilter, warn};
use tracing_subscriber::EnvFilter;

use crate::{
    api::route::get_route_from_db, certs::CertManager, config::Config, error::AppError,
    files::load_file_hidden,
};

type DbPool = Pool<SqliteConnectionManager>;

mod api;
mod auth;
mod certs;
mod config;
mod enroll;
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

/// `service invite <cn> <label> [--admin]`: prints a one-time enrollment
/// link. For bootstrapping the first admin, or when nobody can reach the
/// admin panel. Run from the service's working directory.
fn run_invite_cli(args: &[String], config: &Config, pool: &DbPool) -> Result<(), String> {
    let (cn, label, admin) = match args {
        [cn, label] => (cn, label, false),
        [cn, label, flag] if flag == "--admin" => (cn, label, true),
        _ => return Err("usage: service invite <cn> <label> [--admin]".into()),
    };
    let conn = pool.get().map_err(|e| e.to_string())?;
    let invite = enroll::create_invite(&conn, config, cn, label, "cli").map_err(|e| e.to_string())?;
    if admin {
        conn.execute(
            "INSERT OR IGNORE INTO user_roles (username, role) VALUES (?1, ?2)",
            rusqlite::params![cn, auth::ADMIN_USERS_ROLE],
        )
        .map_err(|e| e.to_string())?;
    }
    let expires = time::OffsetDateTime::from_unix_timestamp(invite.expires_at)
        .map(|t| t.to_string())
        .unwrap_or_default();
    println!("{}", invite.url);
    eprintln!("(single use, expires {expires})");
    Ok(())
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
    // stderr, so stdout carries only a CLI command's output (e.g. the invite URL).
    tracing_subscriber::fmt()
        .with_env_filter(filter.clone())
        .with_writer(std::io::stderr)
        .init();

    info!("EnvFilter: {}", filter);

    info!("Features: {}", env!("BUILD_FEATURES"));

    let config: Config =
        serde_json::from_reader(File::open("service.config.json").unwrap()).unwrap();

    info!("Config: {config:#?}");

    info!("Starting up process service");

    let manager = get_connection_manager(DEFAULT_DB_PATH).unwrap();
    let pool = r2d2::Pool::new(manager).unwrap();

    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Some((cmd, rest)) = args.split_first() {
        let result = match cmd.as_str() {
            "invite" => run_invite_cli(rest, &config, &pool),
            _ => Err(format!("unknown command {cmd:?}; available: invite")),
        };
        if let Err(e) = result {
            eprintln!("{e}");
            std::process::exit(1);
        }
        return;
    }

    let addr = config.addr.to_slice().to_vec();
    if config.dev.is_some() && addr.iter().any(|a| !a.ip().is_loopback()) {
        warn!(
            "`dev` is set and the service listens on a non-loopback address: \
             requests without auth headers are treated as the dev user"
        );
    }

    let certs = Arc::new(CertManager::new(config.certs.clone()).await.unwrap());
    certs.clone().spawn_crl_refresh_task();

    // Everything except enrollment requires a verified client cert.
    let protected = Router::new()
        .nest("/api", api::get_router())
        .nest("/files", files::get_router())
        .route("/", get(|| async { Redirect::to("/files/index.html") }))
        .route("/route/{hash}/{id}", get(get_route))
        .fallback(not_found)
        .layer(middleware::from_fn(auth::auth_middleware));

    let app = protected
        .nest("/enroll", enroll::get_router())
        .layer(middleware::from_fn(error::log_app_errors))
        .layer(Extension(certs))
        .layer(Extension(Arc::new(config)))
        .with_state(pool);

    // let addr = std::env::var("PRICE_ADDR").unwrap_or_else(|_| "127.0.0.1:8001".into());

    // run our app with hyper, listening globally on port 3000
    let listener = tokio::net::TcpListener::bind(&*addr).await.unwrap();
    info!("Listening on http://{}", listener.local_addr().unwrap());
    axum::serve(listener, app).await.unwrap();
}
