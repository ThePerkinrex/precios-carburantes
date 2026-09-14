use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
};
use x509_parser::prelude::*;

use thiserror::Error;

use crate::config::CertConfig;

#[derive(Debug, Error)]
pub enum CertError {
    #[error("IO ERROR: {0}")]
    IO(#[from] std::io::Error),
    #[error("IO ERROR: {0}")]
    X509(#[from] x509_parser::error::X509Error),
}

pub struct CertManager {
    config: CertConfig,
    users: HashMap<String, PathBuf>,
}

impl CertManager {
    pub async fn new(config: CertConfig) -> Result<Self, CertError> {
        tokio::fs::create_dir_all(&config.ca).await?;
        tokio::fs::create_dir_all(&config.user_certs).await?;
        for cert in tokio::fs::read_dir(&config.user_certs).await? {
            let cert = cert?;
            if cert.file_name().to_string_lossy().ends_with(".der") {
                let (_, cert) =
                    X509Certificate::from_der(&tokio::fs::read(cert.path()).await?)?;
                let subject = cert.subject();

                // Find the CN attribute specifically
                let cn = subject
                    .iter_attributes()
                    .find(|attr| attr.attr_type() == &OID_X509_COMMON_NAME)
                    .and_then(|attr| attr.as_str().ok());

                match cn {
                    Some(name) => println!("Assigned name (CN): {}", name),
                    None => println!("No CN found in subject"),
                }
            }
        }
        Ok(Self {
            config,
            users: todo!(),
        })
    }
}
