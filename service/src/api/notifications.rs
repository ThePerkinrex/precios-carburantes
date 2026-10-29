//! Price alerts on saved stations, and the channels (browsers, for now) their notifications go
//! to. Both are private: a user only ever lists or changes their own.

use std::sync::Arc;

use axum::{
    Extension, Json, Router,
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{delete, get, post},
};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::{
    DbPool,
    auth::ClientAuth,
    enroll::now,
    error::{AppError, GenericSilentError},
    notify::{Message, Notifier, Report, WebPushConfig, is_push_endpoint},
};

const MAX_ALERTS: i64 = 50;
const MAX_CHANNELS: i64 = 20;
const MAX_LABEL_LEN: usize = 60;
const MAX_ENDPOINT_LEN: usize = 1024;

fn conflict(message: &'static str) -> AppError {
    GenericSilentError::new((StatusCode::CONFLICT, message).into_response()).into()
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "snake_case")]
enum Fuel {
    GasoleoA,
    #[serde(rename = "gasolina_95")]
    Gasolina95,
}

impl Fuel {
    fn column(self) -> &'static str {
        match self {
            Fuel::GasoleoA => "gasoleo_a",
            Fuel::Gasolina95 => "gasolina_95",
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "snake_case")]
enum Kind {
    AnyDrop,
    DropBy,
    Below,
}

impl Kind {
    fn as_str(self) -> &'static str {
        match self {
            Kind::AnyDrop => "any_drop",
            Kind::DropBy => "drop_by",
            Kind::Below => "below",
        }
    }
}

#[derive(Serialize)]
struct Alert {
    id: i64,
    station_id: i64,
    fuel: String,
    kind: String,
    /// Cents for drop_by, €/l for below.
    value: Option<f64>,
    /// drop_by's starting point: the price when it was made or last fired.
    ref_price: Option<f64>,
    created_at: i64,
}

fn alert_from_row(row: &rusqlite::Row) -> rusqlite::Result<Alert> {
    Ok(Alert {
        id: row.get(0)?,
        station_id: row.get(1)?,
        fuel: row.get(2)?,
        kind: row.get(3)?,
        value: row.get(4)?,
        ref_price: row.get(5)?,
        created_at: row.get(6)?,
    })
}

const ALERT_COLUMNS: &str = "id, station_id, fuel, kind, value, ref_price, created_at";

async fn list_alerts(
    State(pool): State<DbPool>,
    auth: ClientAuth,
) -> Result<Json<Vec<Alert>>, AppError> {
    let conn = pool.get()?;
    let alerts = conn
        .prepare(&format!(
            "SELECT {ALERT_COLUMNS} FROM price_alerts WHERE username = ?1 ORDER BY created_at, id"
        ))?
        .query_map(params![auth.username], alert_from_row)?
        .collect::<Result<_, _>>()?;
    Ok(Json(alerts))
}

#[derive(Deserialize)]
struct NewAlert {
    station_id: i64,
    fuel: Fuel,
    kind: Kind,
    value: Option<f64>,
}

/// Adds an alert to one of the user's saved stations. Setting one that exists (same station,
/// fuel and kind) changes its value and starts drop_by's count again.
async fn put_alert(
    State(pool): State<DbPool>,
    auth: ClientAuth,
    Json(body): Json<NewAlert>,
) -> Result<Json<Alert>, AppError> {
    let value = match (body.kind, body.value) {
        (Kind::AnyDrop, _) => None,
        (Kind::DropBy, Some(v)) if (0.1..=50.0).contains(&v) => Some((v * 10.0).round() / 10.0),
        (Kind::Below, Some(v)) if (0.5..=5.0).contains(&v) => Some((v * 1000.0).round() / 1000.0),
        (Kind::DropBy, _) => {
            return Err(AppError::BadRequest(
                "The drop has to be between 0.1 and 50 cents".into(),
            ));
        }
        (Kind::Below, _) => {
            return Err(AppError::BadRequest(
                "The price has to be between 0.5 and 5 €".into(),
            ));
        }
    };

    let mut conn = pool.get()?;
    let tx = conn.transaction()?;
    let saved = tx
        .query_row(
            "SELECT 1 FROM user_stations WHERE username = ?1 AND station_id = ?2 AND kind = 'saved'",
            params![auth.username, body.station_id],
            |_| Ok(()),
        )
        .optional()?;
    if saved.is_none() {
        return Err(AppError::BadRequest(
            "Save the station before adding alerts to it".into(),
        ));
    }
    let exists = tx
        .query_row(
            "SELECT 1 FROM price_alerts
            WHERE username = ?1 AND station_id = ?2 AND fuel = ?3 AND kind = ?4",
            params![auth.username, body.station_id, body.fuel.column(), body.kind.as_str()],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if !exists {
        let count: i64 = tx.query_row(
            "SELECT COUNT(*) FROM price_alerts WHERE username = ?1",
            params![auth.username],
            |row| row.get(0),
        )?;
        if count >= MAX_ALERTS {
            return Err(conflict(
                "You have the most alerts you can: remove one to add another",
            ));
        }
    }
    let ref_price: Option<f64> = if body.kind == Kind::DropBy {
        tx.query_row(
            &format!(
                "SELECT {} FROM precios_actuales WHERE id_estacion = ?1",
                body.fuel.column()
            ),
            params![body.station_id],
            |row| row.get(0),
        )
        .optional()?
        .flatten()
    } else {
        None
    };
    let alert = tx.query_row(
        &format!(
            "INSERT INTO price_alerts (username, station_id, fuel, kind, value, ref_price, created_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            ON CONFLICT (username, station_id, fuel, kind) DO UPDATE SET
                value = excluded.value, ref_price = excluded.ref_price
            RETURNING {ALERT_COLUMNS}"
        ),
        params![
            auth.username,
            body.station_id,
            body.fuel.column(),
            body.kind.as_str(),
            value,
            ref_price,
            now()
        ],
        alert_from_row,
    )?;
    tx.commit()?;
    Ok(Json(alert))
}

async fn delete_alert(
    State(pool): State<DbPool>,
    auth: ClientAuth,
    Path(id): Path<i64>,
) -> Result<StatusCode, AppError> {
    pool.get()?.execute(
        "DELETE FROM price_alerts WHERE id = ?1 AND username = ?2",
        params![id, auth.username],
    )?;
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct VapidKey {
    key: String,
}

async fn vapid_key(Extension(notifier): Extension<Arc<Notifier>>) -> Json<VapidKey> {
    Json(VapidKey {
        key: notifier.public_key.clone(),
    })
}

#[derive(Serialize)]
struct ChannelInfo {
    id: i64,
    kind: String,
    label: String,
    /// The push endpoint, so a browser can tell whether it's this one.
    address: String,
    created_at: i64,
    last_ok_at: Option<i64>,
    failures: i64,
}

async fn list_channels(
    State(pool): State<DbPool>,
    auth: ClientAuth,
) -> Result<Json<Vec<ChannelInfo>>, AppError> {
    let conn = pool.get()?;
    let channels = conn
        .prepare(
            "SELECT id, kind, label, address, created_at, last_ok_at, failures
            FROM notification_channels WHERE username = ?1 ORDER BY created_at, id",
        )?
        .query_map(params![auth.username], |row| {
            Ok(ChannelInfo {
                id: row.get(0)?,
                kind: row.get(1)?,
                label: row.get(2)?,
                address: row.get(3)?,
                created_at: row.get(4)?,
                last_ok_at: row.get(5)?,
                failures: row.get(6)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    Ok(Json(channels))
}

#[derive(Deserialize)]
struct SubscriptionKeys {
    p256dh: String,
    auth: String,
}

/// What `PushSubscription.toJSON()` gives, plus a name for the device and its language. When
/// the browser replaces a subscription, the service worker sends the new one with the old's
/// endpoint instead, and the new one takes the old's place.
#[derive(Deserialize)]
struct NewSubscription {
    endpoint: String,
    keys: SubscriptionKeys,
    label: Option<String>,
    lang: Option<String>,
    old_endpoint: Option<String>,
}

#[derive(Serialize)]
struct ChannelId {
    id: i64,
}

/// Registers this browser's push subscription, or updates it. A browser has one subscription
/// per site, so registering it again (after signing in as someone else on it) moves it.
async fn put_webpush(
    State(pool): State<DbPool>,
    auth: ClientAuth,
    Json(body): Json<NewSubscription>,
) -> Result<Json<ChannelId>, AppError> {
    if body.endpoint.len() > MAX_ENDPOINT_LEN || !is_push_endpoint(&body.endpoint) {
        return Err(AppError::BadRequest(
            "This browser's push service isn't supported".into(),
        ));
    }
    let mut conn = pool.get()?;
    let tx = conn.transaction()?;

    let replaced: Option<(i64, String, String)> = match &body.old_endpoint {
        Some(old) => tx
            .query_row(
                "SELECT id, label, config FROM notification_channels
                WHERE kind = 'webpush' AND address = ?1 AND username = ?2",
                params![old, auth.username],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?,
        None => None,
    };
    let (old_label, old_lang) = match &replaced {
        Some((_, label, config)) => (
            Some(label.clone()),
            serde_json::from_str::<WebPushConfig>(config)
                .ok()
                .and_then(|c| c.lang),
        ),
        None => (None, None),
    };
    if let Some((id, _, _)) = &replaced {
        tx.execute("DELETE FROM notification_channels WHERE id = ?1", params![id])?;
    }

    let config = WebPushConfig {
        p256dh: body.keys.p256dh,
        auth: body.keys.auth,
        lang: body.lang.filter(|l| l == "es" || l == "en").or(old_lang),
    };
    if !config.is_valid() {
        return Err(AppError::BadRequest("Invalid push subscription".into()));
    }
    let label: String = body
        .label
        .as_deref()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .or(old_label.as_deref())
        .unwrap_or("Browser")
        .chars()
        .take(MAX_LABEL_LEN)
        .collect();
    let mine = tx
        .query_row(
            "SELECT 1 FROM notification_channels
            WHERE kind = 'webpush' AND address = ?1 AND username = ?2",
            params![body.endpoint, auth.username],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if !mine {
        let count: i64 = tx.query_row(
            "SELECT COUNT(*) FROM notification_channels WHERE username = ?1",
            params![auth.username],
            |row| row.get(0),
        )?;
        if count >= MAX_CHANNELS {
            return Err(conflict(
                "You have the most devices you can: remove one to add another",
            ));
        }
    }
    let id = tx.query_row(
        "INSERT INTO notification_channels (username, kind, address, label, config, created_at)
        VALUES (?1, 'webpush', ?2, ?3, ?4, ?5)
        ON CONFLICT (kind, address) DO UPDATE SET
            username = excluded.username,
            label = excluded.label,
            config = excluded.config,
            failures = 0
        RETURNING id",
        params![
            auth.username,
            body.endpoint,
            label,
            serde_json::to_string(&config).expect("serializable"),
            now()
        ],
        |row| row.get(0),
    )?;
    tx.commit()?;
    Ok(Json(ChannelId { id }))
}

async fn delete_channel(
    State(pool): State<DbPool>,
    auth: ClientAuth,
    Path(id): Path<i64>,
) -> Result<StatusCode, AppError> {
    pool.get()?.execute(
        "DELETE FROM notification_channels WHERE id = ?1 AND username = ?2",
        params![id, auth.username],
    )?;
    Ok(StatusCode::NO_CONTENT)
}

/// Sends a test message to every channel the user linked.
async fn send_test(
    State(pool): State<DbPool>,
    Extension(notifier): Extension<Arc<Notifier>>,
    auth: ClientAuth,
) -> Result<Json<Report>, AppError> {
    Ok(Json(
        notifier
            .send_to_user(&pool, &auth.username, Message::test)
            .await?,
    ))
}

pub fn get_router() -> Router<DbPool> {
    Router::new()
        .route("/alerts", get(list_alerts).post(put_alert))
        .route("/alerts/{id}", delete(delete_alert))
        .route("/vapid-key", get(vapid_key))
        .route("/channels", get(list_channels))
        .route("/channels/webpush", post(put_webpush))
        .route("/channels/{id}", delete(delete_channel))
        .route("/test", post(send_test))
}
