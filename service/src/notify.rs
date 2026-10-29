//! Sending notifications to the channels each user linked: the price alerts the downloader
//! queues in `notification_outbox`, and test messages. Only Web Push so far.
//!
//! Messages are rendered when sent, in the user's language (or the one the browser had when
//! it subscribed, if they follow the browser's).

use std::{collections::HashMap, path::Path, time::Duration};

use axum::http::Uri;
use base64ct::{Base64UrlUnpadded, Encoding};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use tracing::{error, info, warn};
use web_push_native::{
    Auth, WebPushBuilder,
    jwt_simple::algorithms::{ECDSAP256PublicKeyLike, ES256KeyPair},
    p256::PublicKey,
};

use crate::{DbPool, certs::write_private, config::Config, enroll::now, error::AppError};

/// How often the outbox is checked. The downloader runs four times a day, so a minute late
/// doesn't matter.
const POLL_INTERVAL: Duration = Duration::from_secs(60);
/// How long push services keep a message for a device that's offline.
const PUSH_TTL: Duration = Duration::from_secs(12 * 60 * 60);
/// A message that couldn't be sent by then is dropped: the prices will have moved on.
const GIVE_UP_AFTER: i64 = 12 * 60 * 60;
const MAX_ATTEMPTS: i64 = 6;
/// Sent messages are kept this long, for debugging.
const KEEP_SENT: i64 = 30 * 24 * 60 * 60;

/// Where Web Push subscriptions can point: the push services of Chrome and the browsers built
/// on it (FCM, and lately hosts like jmt17.google.com), Firefox, Edge and Safari. The server
/// POSTs to these addresses, so they can't be left to whoever registers one.
const PUSH_HOSTS: &[&str] = &[
    "fcm.googleapis.com",
    "android.googleapis.com",
    ".google.com",
    "web.push.apple.com",
    ".push.apple.com",
    ".push.services.mozilla.com",
    ".notify.windows.com",
];

pub fn is_push_endpoint(url: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(url) else {
        return false;
    };
    let Some(host) = url.host_str() else {
        return false;
    };
    url.scheme() == "https"
        && url.port().is_none()
        && PUSH_HOSTS.iter().any(|allowed| {
            if allowed.starts_with('.') {
                host.ends_with(allowed)
            } else {
                host == *allowed
            }
        })
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Lang {
    En,
    Es,
}

impl Lang {
    fn parse(s: Option<&str>) -> Option<Self> {
        match s {
            Some("es") => Some(Self::Es),
            Some("en") => Some(Self::En),
            _ => None,
        }
    }

    fn pick<'a>(self, en: &'a str, es: &'a str) -> &'a str {
        match self {
            Self::En => en,
            Self::Es => es,
        }
    }

    /// Prices with three decimals, with a decimal comma in Spanish.
    fn price(self, p: f64) -> String {
        self.decimal(format!("{p:.3}"))
    }

    fn cents(self, c: f64) -> String {
        self.decimal(format!("{c:.1}"))
    }

    fn decimal(self, s: String) -> String {
        match self {
            Self::En => s,
            Self::Es => s.replace('.', ","),
        }
    }
}

/// What a notification shows. The service worker turns it into one.
#[derive(Serialize, Debug, PartialEq)]
pub struct Message {
    pub title: String,
    pub body: String,
    /// Opened when the notification is tapped.
    pub url: &'static str,
}

impl Message {
    pub fn test(lang: Lang) -> Self {
        Self {
            title: lang.pick("Test notification", "Notificación de prueba").into(),
            body: lang
                .pick(
                    "Price alerts will show up like this.",
                    "Los avisos de precio aparecerán así.",
                )
                .into(),
            url: "/files/stations",
        }
    }
}

/// An alert that fired, as the downloader queues it.
#[derive(Deserialize, Debug, Clone)]
pub struct Fired {
    pub station_id: i64,
    pub fuel: String,
    pub kind: String,
    pub value: Option<f64>,
    pub from: f64,
    pub to: f64,
}

#[derive(Deserialize)]
struct OutboxBody {
    alerts: Vec<Fired>,
}

fn fuel_name(fuel: &str) -> &'static str {
    match fuel {
        "gasoleo_a" => "Gasóleo A",
        _ => "Gasolina 95",
    }
}

/// A line per station and fuel: "1.459 → 1.429 €/l (−3.0 c, below 1.430)". When several of the
/// user's rules fired for the same price, the line says why each one did.
fn render_alerts(lang: Lang, alerts: &[Fired], names: &HashMap<i64, String>) -> Message {
    let mut groups: Vec<(i64, &str, Vec<&Fired>)> = Vec::new();
    for fired in alerts {
        match groups
            .iter_mut()
            .find(|(s, f, _)| *s == fired.station_id && *f == fired.fuel)
        {
            Some((_, _, list)) => list.push(fired),
            None => groups.push((fired.station_id, &fired.fuel, vec![fired])),
        }
    }
    let name = |id: i64| names.get(&id).cloned().unwrap_or_else(|| format!("#{id}"));

    let lines: Vec<String> = groups
        .iter()
        .map(|(_, _, list)| {
            let to = list[0].to;
            // The previous price, unless only drop_by fired: then the one it measured from.
            let from = list
                .iter()
                .find(|f| f.kind != "drop_by")
                .unwrap_or(&list[0])
                .from;
            let mut why = vec![format!("−{} c", lang.cents((from - to) * 100.0))];
            for f in list {
                match f.kind.as_str() {
                    "below" => why.push(format!(
                        "{} {}",
                        lang.pick("below", "por debajo de"),
                        lang.price(f.value.unwrap_or_default())
                    )),
                    "drop_by" if f.from != from => why.push(format!(
                        "−{} c {} {}",
                        lang.cents((f.from - to) * 100.0),
                        lang.pick("since", "desde"),
                        lang.price(f.from)
                    )),
                    _ => {}
                }
            }
            format!(
                "{} → {} €/l ({})",
                lang.price(from),
                lang.price(to),
                why.join(", ")
            )
        })
        .collect();

    let stations = {
        let mut ids: Vec<i64> = groups.iter().map(|(s, _, _)| *s).collect();
        ids.sort_unstable();
        ids.dedup();
        ids
    };
    let (title, body) = match (groups.as_slice(), stations.as_slice()) {
        ([(station, fuel, _)], _) => (
            match lang {
                Lang::En => format!("{} down at {}", fuel_name(fuel), name(*station)),
                Lang::Es => format!("Baja el {} en {}", fuel_name(fuel), name(*station)),
            },
            lines[0].clone(),
        ),
        (_, [station]) => (
            match lang {
                Lang::En => format!("Prices down at {}", name(*station)),
                Lang::Es => format!("Bajan los precios en {}", name(*station)),
            },
            groups
                .iter()
                .zip(&lines)
                .map(|((_, fuel, _), line)| format!("{}: {line}", fuel_name(fuel)))
                .collect::<Vec<_>>()
                .join("\n"),
        ),
        _ => (
            match lang {
                Lang::En => format!("Prices down at {} of your stations", stations.len()),
                Lang::Es => format!("Bajan los precios en {} de tus gasolineras", stations.len()),
            },
            groups
                .iter()
                .zip(&lines)
                .map(|((station, fuel, _), line)| {
                    format!("{} · {}: {line}", name(*station), fuel_name(fuel))
                })
                .collect::<Vec<_>>()
                .join("\n"),
        ),
    };
    Message {
        title,
        body,
        url: "/files/stations",
    }
}

/// The nickname the user gave each station, or its brand and town.
fn station_names(
    conn: &Connection,
    username: &str,
    alerts: &[Fired],
) -> rusqlite::Result<HashMap<i64, String>> {
    let mut stmt = conn.prepare_cached(
        "SELECT u.nickname, e.rotulo, COALESCE(e.localidad, e.municipio)
        FROM estaciones e
        LEFT JOIN user_stations u ON u.station_id = e.id AND u.username = ?1
        WHERE e.id = ?2",
    )?;
    let mut names = HashMap::new();
    for fired in alerts {
        if names.contains_key(&fired.station_id) {
            continue;
        }
        let row = stmt
            .query_row(params![username, fired.station_id], |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            })
            .optional()?;
        if let Some((nickname, rotulo, town)) = row {
            let name = nickname.unwrap_or_else(|| match (rotulo, town) {
                (Some(r), Some(t)) if !t.is_empty() => format!("{r} ({t})"),
                (Some(r), _) => r,
                (None, _) => format!("#{}", fired.station_id),
            });
            names.insert(fired.station_id, name);
        }
    }
    Ok(names)
}

/// A Web Push subscription's keys, and the language of the browser that made it.
#[derive(Serialize, Deserialize)]
pub struct WebPushConfig {
    pub p256dh: String,
    pub auth: String,
    #[serde(default)]
    pub lang: Option<String>,
}

impl WebPushConfig {
    /// Whether the keys are what a browser gives: a P-256 public key and a 16 byte secret.
    pub fn is_valid(&self) -> bool {
        self.keys().is_some()
    }

    fn keys(&self) -> Option<(PublicKey, Auth)> {
        let public = Base64UrlUnpadded::decode_vec(self.p256dh.trim_end_matches('=')).ok()?;
        let auth = Base64UrlUnpadded::decode_vec(self.auth.trim_end_matches('=')).ok()?;
        if auth.len() != 16 {
            return None;
        }
        Some((
            PublicKey::from_sec1_bytes(&public).ok()?,
            Auth::clone_from_slice(&auth),
        ))
    }
}

struct Channel {
    id: i64,
    address: String,
    config: String,
}

enum Outcome {
    Sent,
    /// The subscription no longer exists: forget the channel.
    Gone,
    Failed(String),
}

/// What happened to one message, channel by channel.
#[derive(Serialize, Default, Debug)]
pub struct Report {
    pub sent: usize,
    pub failed: usize,
    /// Channels that turned out to be gone, and were removed.
    pub removed: usize,
}

pub struct Notifier {
    key: ES256KeyPair,
    /// The key's public half, base64url: the browsers' `applicationServerKey`.
    pub public_key: String,
    contact: String,
    client: reqwest::Client,
}

impl Notifier {
    pub async fn new(config: &Config) -> Result<Self, Box<dyn std::error::Error>> {
        let key = load_or_create_key(&config.notifications.vapid_key).await?;
        let public_key =
            Base64UrlUnpadded::encode_string(&key.public_key().public_key().to_bytes_uncompressed());
        let contact = config
            .notifications
            .contact
            .clone()
            .unwrap_or_else(|| config.public_url.clone());
        let client = reqwest::Client::builder()
            .user_agent("PrecioCarburantes/1.0.0")
            .timeout(Duration::from_secs(30))
            // Only ever talk to the push service the endpoint names.
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        Ok(Self {
            key,
            public_key,
            contact,
            client,
        })
    }

    /// Sends what the downloader queues, every POLL_INTERVAL.
    pub fn spawn_outbox_task(self: std::sync::Arc<Self>, pool: DbPool) {
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(POLL_INTERVAL);
            loop {
                ticker.tick().await;
                if let Err(e) = self.process_outbox(&pool).await {
                    error!("Sending notifications failed: {e}");
                }
            }
        });
    }

    async fn process_outbox(&self, pool: &DbPool) -> Result<(), AppError> {
        let now = now();
        let due: Vec<(i64, String, String, i64)> = {
            let conn = pool.get()?;
            conn.execute(
                "DELETE FROM notification_outbox WHERE created_at < ?1",
                params![now - KEEP_SENT],
            )?;
            conn.prepare(
                "SELECT id, username, body, attempts FROM notification_outbox
                WHERE sent_at IS NULL AND next_attempt_at <= ?1
                    AND attempts < ?2 AND created_at >= ?3
                ORDER BY id",
            )?
            .query_map(params![now, MAX_ATTEMPTS, now - GIVE_UP_AFTER], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })?
            .collect::<Result<_, _>>()?
        };

        for (id, username, body, attempts) in due {
            let alerts = match serde_json::from_str::<OutboxBody>(&body) {
                Ok(b) => b.alerts,
                Err(e) => {
                    error!("Unreadable notification {id}: {e}");
                    pool.get()?.execute(
                        "UPDATE notification_outbox SET attempts = ?2 WHERE id = ?1",
                        params![id, MAX_ATTEMPTS],
                    )?;
                    continue;
                }
            };
            let names = station_names(&*pool.get()?, &username, &alerts)?;
            let report = self
                .send_to_user(pool, &username, |lang| render_alerts(lang, &alerts, &names))
                .await?;
            info!("Notification {id} for {username}: {report:?}");

            let conn = pool.get()?;
            // Sent if any channel got it. If the user has no channels, there's nothing to do.
            if report.sent > 0 || report.failed == 0 {
                conn.execute(
                    "UPDATE notification_outbox SET sent_at = ?2, attempts = attempts + 1
                    WHERE id = ?1",
                    params![id, now],
                )?;
            } else {
                // 2, 4, 8... minutes.
                conn.execute(
                    "UPDATE notification_outbox SET attempts = attempts + 1, next_attempt_at = ?2
                    WHERE id = ?1",
                    params![id, now + (120 << attempts)],
                )?;
            }
        }
        Ok(())
    }

    /// Sends `message`, rendered in the user's language, to every channel `username` linked.
    pub async fn send_to_user(
        &self,
        pool: &DbPool,
        username: &str,
        message: impl Fn(Lang) -> Message,
    ) -> Result<Report, AppError> {
        let (language, channels) = {
            let conn = pool.get()?;
            let language: Option<String> = conn
                .query_row(
                    "SELECT language FROM user_configs WHERE username = ?1",
                    params![username],
                    |row| row.get(0),
                )
                .optional()?
                .flatten();
            let channels: Vec<Channel> = conn
                .prepare(
                    "SELECT id, address, config FROM notification_channels
                    WHERE username = ?1 AND kind = 'webpush'",
                )?
                .query_map(params![username], |row| {
                    Ok(Channel {
                        id: row.get(0)?,
                        address: row.get(1)?,
                        config: row.get(2)?,
                    })
                })?
                .collect::<Result<_, _>>()?;
            (Lang::parse(language.as_deref()), channels)
        };

        let mut report = Report::default();
        for channel in channels {
            let config: Option<WebPushConfig> = serde_json::from_str(&channel.config).ok();
            let lang = language
                .or_else(|| Lang::parse(config.as_ref()?.lang.as_deref()))
                .unwrap_or(Lang::En);
            let outcome = match config {
                Some(config) => self.web_push(&channel.address, &config, &message(lang)).await,
                None => Outcome::Failed("unreadable config".into()),
            };

            let conn = pool.get()?;
            match outcome {
                Outcome::Sent => {
                    report.sent += 1;
                    conn.execute(
                        "UPDATE notification_channels SET last_ok_at = ?2, failures = 0 WHERE id = ?1",
                        params![channel.id, now()],
                    )?;
                }
                Outcome::Gone => {
                    report.removed += 1;
                    info!("Removing expired push subscription {} of {username}", channel.id);
                    conn.execute(
                        "DELETE FROM notification_channels WHERE id = ?1",
                        params![channel.id],
                    )?;
                }
                Outcome::Failed(why) => {
                    report.failed += 1;
                    warn!("Push to channel {} of {username} failed: {why}", channel.id);
                    conn.execute(
                        "UPDATE notification_channels SET failures = failures + 1 WHERE id = ?1",
                        params![channel.id],
                    )?;
                }
            }
        }
        Ok(report)
    }

    async fn web_push(&self, endpoint: &str, config: &WebPushConfig, message: &Message) -> Outcome {
        let Some((public, auth)) = config.keys() else {
            return Outcome::Failed("invalid subscription keys".into());
        };
        let uri: Uri = match endpoint.parse() {
            Ok(uri) => uri,
            Err(e) => return Outcome::Failed(format!("invalid endpoint: {e}")),
        };
        let payload = serde_json::to_vec(message).expect("serializable");
        let request = WebPushBuilder::new(uri, public, auth)
            .with_valid_duration(PUSH_TTL)
            .with_vapid(&self.key, &self.contact)
            .build(payload)
            .map_err(|e| e.to_string())
            .and_then(|r| reqwest::Request::try_from(r).map_err(|e| e.to_string()));
        let request = match request {
            Ok(r) => r,
            Err(e) => return Outcome::Failed(e),
        };
        match self.client.execute(request).await {
            Ok(r) if r.status().is_success() => Outcome::Sent,
            Ok(r) if matches!(r.status().as_u16(), 404 | 410) => Outcome::Gone,
            Ok(r) => {
                let status = r.status();
                let text = r.text().await.unwrap_or_default();
                Outcome::Failed(format!("{status}: {}", text.chars().take(200).collect::<String>()))
            }
            Err(e) => Outcome::Failed(e.to_string()),
        }
    }
}

/// The VAPID key is a P-256 private key, stored as base64url.
async fn load_or_create_key(path: &Path) -> Result<ES256KeyPair, Box<dyn std::error::Error>> {
    match tokio::fs::read_to_string(path).await {
        Ok(text) => {
            let bytes = Base64UrlUnpadded::decode_vec(text.trim())
                .map_err(|e| format!("{}: {e}", path.display()))?;
            Ok(ES256KeyPair::from_bytes(&bytes)?)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            info!("Creating the Web Push key {}", path.display());
            let key = ES256KeyPair::generate();
            if let Some(dir) = path.parent() {
                tokio::fs::create_dir_all(dir).await?;
            }
            write_private(path, Base64UrlUnpadded::encode_string(&key.to_bytes()).as_bytes())
                .await?;
            Ok(key)
        }
        Err(e) => Err(format!("{}: {e}", path.display()).into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fired(station_id: i64, fuel: &str, kind: &str, value: Option<f64>, from: f64, to: f64) -> Fired {
        Fired {
            station_id,
            fuel: fuel.into(),
            kind: kind.into(),
            value,
            from,
            to,
        }
    }

    fn names() -> HashMap<i64, String> {
        HashMap::from([(1, "Home".to_string()), (2, "REPSOL (Getafe)".to_string())])
    }

    #[test]
    fn one_alert() {
        let m = render_alerts(Lang::En, &[fired(1, "gasoleo_a", "any_drop", None, 1.459, 1.429)], &names());
        assert_eq!(m.title, "Gasóleo A down at Home");
        assert_eq!(m.body, "1.459 → 1.429 €/l (−3.0 c)");
        let m = render_alerts(Lang::Es, &[fired(1, "gasoleo_a", "below", Some(1.43), 1.459, 1.429)], &names());
        assert_eq!(m.title, "Baja el Gasóleo A en Home");
        assert_eq!(m.body, "1,459 → 1,429 €/l (−3,0 c, por debajo de 1,430)");
    }

    #[test]
    fn drop_by_since_reference() {
        let alerts = [
            fired(1, "gasoleo_a", "any_drop", None, 1.480, 1.470),
            fired(1, "gasoleo_a", "drop_by", Some(3.0), 1.500, 1.470),
        ];
        let m = render_alerts(Lang::En, &alerts, &names());
        assert_eq!(m.body, "1.480 → 1.470 €/l (−1.0 c, −3.0 c since 1.500)");
        // On its own, drop_by shows the drop from its reference.
        let m = render_alerts(Lang::En, &alerts[1..], &names());
        assert_eq!(m.body, "1.500 → 1.470 €/l (−3.0 c)");
    }

    #[test]
    fn several_stations() {
        let alerts = [
            fired(1, "gasoleo_a", "any_drop", None, 1.459, 1.429),
            fired(2, "gasolina_95", "any_drop", None, 1.6, 1.59),
        ];
        let m = render_alerts(Lang::En, &alerts, &names());
        assert_eq!(m.title, "Prices down at 2 of your stations");
        assert_eq!(
            m.body,
            "Home · Gasóleo A: 1.459 → 1.429 €/l (−3.0 c)\nREPSOL (Getafe) · Gasolina 95: 1.600 → 1.590 €/l (−1.0 c)"
        );
        let both_fuels = [alerts[0].clone(), fired(1, "gasolina_95", "any_drop", None, 1.6, 1.59)];
        let m = render_alerts(Lang::Es, &both_fuels, &names());
        assert_eq!(m.title, "Bajan los precios en Home");
    }

    #[test]
    fn push_hosts() {
        assert!(is_push_endpoint("https://fcm.googleapis.com/fcm/send/abc"));
        assert!(is_push_endpoint("https://web.push.apple.com/QGx"));
        assert!(is_push_endpoint("https://updates.push.services.mozilla.com/wpush/v2/x"));
        assert!(is_push_endpoint("https://jmt17.google.com/fcm/send/x"));
        assert!(!is_push_endpoint("https://google.com.evil.example/x"));
        assert!(!is_push_endpoint("http://fcm.googleapis.com/fcm/send/abc"));
        assert!(!is_push_endpoint("https://fcm.googleapis.com.evil.example/x"));
        assert!(!is_push_endpoint("https://evilpush.apple.com/x"));
        assert!(!is_push_endpoint("https://push.apple.com/x"));
        assert!(!is_push_endpoint("https://fcm.googleapis.com:8443/x"));
        assert!(!is_push_endpoint("https://192.168.1.1/x"));
    }
}
