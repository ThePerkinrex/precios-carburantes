use std::{borrow::Cow, net::SocketAddr, path::PathBuf};

use serde::Deserialize;

#[derive(Debug, Deserialize, Clone)]
#[serde(untagged)]
pub enum SocketAddrs {
    Single(SocketAddr),
    Multiple(Vec<SocketAddr>),
}

impl SocketAddrs {
    pub fn to_slice(&self) -> Cow<'_, [SocketAddr]> {
        match self {
            Self::Single(socket_addr) => Cow::Owned(vec![*socket_addr]),
            Self::Multiple(socket_addrs) => Cow::Borrowed(socket_addrs),
        }
    }
}

#[derive(Debug, Deserialize, Clone)]
pub struct DevConfig {
    pub user: String,
    #[serde(default)]
    pub roles: Vec<String>,
}

fn ca_default() -> PathBuf {
    PathBuf::from("certs/CA")
}

fn user_certs_default() -> PathBuf {
    PathBuf::from("certs/users")
}

fn ca_name_default() -> String {
    "carburantes-CA".to_string()
}

const fn invite_ttl_hours_default() -> u32 {
    48
}

#[derive(Debug, Deserialize, Clone)]
pub struct CertConfig {
    #[serde(default = "ca_default")]
    pub ca: PathBuf,
    #[serde(default = "user_certs_default")]
    pub user_certs: PathBuf,
    #[serde(default)]
    pub reload_nginx: bool,
    /// CN of the CA, only used when a new one has to be created.
    #[serde(default = "ca_name_default")]
    pub ca_name: String,
    #[serde(default = "invite_ttl_hours_default")]
    pub invite_ttl_hours: u32,
}

impl Default for CertConfig {
    fn default() -> Self {
        Self {
            ca: ca_default(),
            user_certs: user_certs_default(),
            reload_nginx: Default::default(),
            ca_name: ca_name_default(),
            invite_ttl_hours: invite_ttl_hours_default(),
        }
    }
}

fn vapid_key_default() -> PathBuf {
    PathBuf::from("certs/vapid.key")
}

#[derive(Debug, Deserialize, Clone)]
pub struct NotificationsConfig {
    /// The private key that signs Web Push requests (VAPID). Made on first start if missing.
    /// Changing it invalidates every browser's subscription.
    #[serde(default = "vapid_key_default")]
    pub vapid_key: PathBuf,
    /// Who push services can contact about our messages: a `mailto:` or `https:` URL.
    /// Defaults to `public_url`.
    #[serde(default)]
    pub contact: Option<String>,
}

impl Default for NotificationsConfig {
    fn default() -> Self {
        Self {
            vapid_key: vapid_key_default(),
            contact: None,
        }
    }
}

fn public_url_default() -> String {
    "http://localhost:8001".to_string()
}

#[derive(Debug, Deserialize, Clone)]
pub struct Config {
    pub addr: SocketAddrs,
    pub dev: Option<DevConfig>,
    #[serde(default)]
    pub certs: CertConfig,
    /// Externally visible base URL (no trailing slash), used for invite links.
    #[serde(default = "public_url_default")]
    pub public_url: String,
    #[serde(default)]
    pub notifications: NotificationsConfig,
}
