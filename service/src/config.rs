use std::{borrow::Cow, net::SocketAddr};

use serde::Deserialize;


#[derive(Debug, Deserialize, Clone)]
#[serde(untagged)]
pub enum SocketAddrs {
	Single(SocketAddr),
	Multiple(Vec<SocketAddr>)
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
	pub user: String
}

#[derive(Debug, Deserialize, Clone)]
pub struct Config {
	pub addr: SocketAddrs,
	pub dev: Option<DevConfig>
}