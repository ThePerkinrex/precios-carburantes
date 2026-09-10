use crate::config::PemConfig;


pub struct CertManager {
	config: PemConfig
}

impl CertManager {
	pub fn new(config: PemConfig) -> Self {
		Self { config }
	}
}
