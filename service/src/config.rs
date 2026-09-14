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


#[derive(Debug, Deserialize, Clone)]
pub struct CertConfig {
    #[serde(default = "ca_default")]
    pub ca: PathBuf,
    #[serde(default = "user_certs_default")]
    pub user_certs: PathBuf,
    #[serde(default)]
    pub reload_nginx: bool
}

impl Default for CertConfig {
    fn default() -> Self {
        Self { ca: ca_default(), user_certs: user_certs_default(), reload_nginx: Default::default() }
    }
}

#[derive(Debug, Deserialize, Clone)]
pub struct Config {
    pub addr: SocketAddrs,
    pub dev: Option<DevConfig>,
    #[serde(default)]
    pub certs: CertConfig
}
