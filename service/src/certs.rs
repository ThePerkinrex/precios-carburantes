//! Manages the mTLS CA: issues and revokes client certificates, keeps the
//! CRL current, and reloads nginx so it picks up changes.
//!
//! Files on disk, all under `CertConfig::ca`:
//!   ca-cert.pem   — CA cert.        nginx: `ssl_client_certificate`
//!   ca-key.pem    — CA private key. Never leaves this directory.
//!   crl.pem       — current CRL.    nginx: `ssl_crl`
//!   crl.number    — monotonic CRL sequence number, bumped on every re-sign.
//!   revoked.log   — append-only revocation record: serial, cn, reason, timestamp.
//!                   The durable source of truth for what belongs in the CRL.
//!
//! Issued client certs live under `CertConfig::user_certs` as `<serial-hex>.der`.
//!
//! Requires `rcgen` with the `pem` feature, and `rcgen` >= 0.14.5 (for
//! `impl SigningKey for &impl SigningKey`, used by `Issuer::from_params`).

use std::{
    cmp::Reverse,
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration as StdDuration,
};

use rcgen::{
    BasicConstraints, CertificateParams, CertificateRevocationListParams, DistinguishedName,
    DnType, ExtendedKeyUsagePurpose, IsCa, Issuer, KeyIdMethod, KeyPair, KeyUsagePurpose,
    RevocationReason, RevokedCertParams, SerialNumber,
};
use thiserror::Error;
use time::{Duration, OffsetDateTime};
use tokio::{io::AsyncWriteExt, sync::RwLock};
use x509_parser::{
    asn1_rs::FromDer, certificate::X509Certificate, oid_registry::OID_X509_COMMON_NAME,
};

use crate::config::CertConfig;

#[derive(Debug, Error)]
pub enum CertError {
    #[error("IO error: {0}")]
    IO(#[from] std::io::Error),
    #[error("X509 parse error: {0}")]
    X509(#[from] x509_parser::asn1_rs::Err<x509_parser::error::X509Error>),
    #[error("certificate generation error: {0}")]
    Rcgen(#[from] rcgen::Error),
    #[error("no cert found for serial {0}")]
    NotFound(String),
    #[error("nginx reload failed (exit code {0:?})")]
    Reload(Option<i32>),
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CA_CERT_PEM_FILE: &str = "ca-cert.pem";
const CA_KEY_PEM_FILE: &str = "ca-key.pem";
const CRL_PEM_FILE: &str = "crl.pem";
const CRL_NUMBER_FILE: &str = "crl.number";
const REVOKED_LOG_FILE: &str = "revoked.log";

const CA_VALIDITY: Duration = Duration::days(365 * 10);
const USER_CERT_VALIDITY: Duration = Duration::days(365);
const CRL_VALIDITY: Duration = Duration::days(30);

/// Re-sign the CRL once we're within this long of its `next_update`, even
/// with no new revocations, so it never goes stale.
const CRL_REFRESH_MARGIN: Duration = Duration::days(7);
/// How often the background task checks whether a refresh is due.
const CRL_CHECK_INTERVAL: StdDuration = StdDuration::from_secs(60 * 60);

// ---------------------------------------------------------------------------
// Public data model
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub enum CertStatus {
    Active,
    Revoked {
        at: OffsetDateTime,
        reason: RevocationReason,
    },
}

#[derive(Debug, Clone)]
pub struct UserCert {
    pub cn: String,
    pub serial: SerialNumber,
    pub path: PathBuf,
    pub issued_at: OffsetDateTime,
    pub not_after: OffsetDateTime,
    pub status: CertStatus,
}

/// Returned by `issue_cert`. This is the only moment the private key exists
/// outside the client's own hands — the caller must deliver it and not
/// persist it; `CertManager` never stores user private keys.
pub struct IssuedCert {
    pub cn: String,
    pub serial: String,
    pub cert_pem: String,
    pub key_pem: String,
}

/// Admin-panel view: one entry per CN, with every cert ever issued to it.
pub struct UserSummary {
    pub cn: String,
    pub certs: Vec<CertSummary>,
}

pub struct CertSummary {
    pub serial: String,
    pub issued_at: OffsetDateTime,
    pub not_after: OffsetDateTime,
    pub status: CertStatus,
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

/// Everything that changes at runtime, behind one lock. Reads (admin listing)
/// take a read lock; issue/revoke/refresh take a write lock. `tokio::sync::RwLock`
/// specifically, not `std::sync` — issue/revoke hold the lock across `.await`
/// points (file writes), which the std-lib lock isn't safe for.
struct Inner {
    ca_key: KeyPair,
    /// serial (hex) -> cert record. Built from disk at startup, then kept in
    /// sync with `revoked.log` on every write — this map is what `resign_crl`
    /// reads from, so there's never a separate "is this actually revoked" check.
    certs: HashMap<String, UserCert>,
    crl_number: u64,
    crl_next_update: OffsetDateTime,
}

pub struct CertManager {
    config: CertConfig,
    inner: RwLock<Inner>,
}

// ---------------------------------------------------------------------------
// Free helpers
// ---------------------------------------------------------------------------

fn serial_to_hex(serial: &SerialNumber) -> String {
    serial.as_ref().iter().map(|b| format!("{b:02x}")).collect()
}

const fn reason_to_code(reason: RevocationReason) -> u8 {
    reason as u8
}

const fn reason_from_code(code: u8) -> RevocationReason {
    use RevocationReason::*;
    match code {
        1 => KeyCompromise,
        2 => CaCompromise,
        3 => AffiliationChanged,
        4 => Superseded,
        5 => CessationOfOperation,
        6 => CertificateHold,
        8 => RemoveFromCrl,
        9 => PrivilegeWithdrawn,
        10 => AaCompromise,
        _ => Unspecified,
    }
}

/// The CA's own identity params — same DN and key usages every time, so any
/// `Issuer` built from this always matches the actual CA cert in ca-cert.pem.
/// Signing only needs the DN/usages/key-id-method, not the CA cert's own
/// validity window, so we never need to keep the CA cert's DER around just
/// to re-derive an `Issuer` after a restart.
fn ca_params_template() -> Result<CertificateParams, CertError> {
    let mut params = CertificateParams::new(Vec::<String>::new())?;
    params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    params.key_usages = vec![
        KeyUsagePurpose::KeyCertSign,
        KeyUsagePurpose::CrlSign,
        KeyUsagePurpose::DigitalSignature,
    ];
    let mut dn = DistinguishedName::new();
    dn.push(DnType::CommonName, "My App Root CA"); // TODO: pull from config
    params.distinguished_name = dn;
    Ok(params)
}

// ---------------------------------------------------------------------------
// Startup: load or create the CA, load issued certs and revocation state
// ---------------------------------------------------------------------------

impl CertManager {
    pub async fn new(config: CertConfig) -> Result<Self, CertError> {
        tokio::fs::create_dir_all(&config.ca).await?;
        tokio::fs::create_dir_all(&config.user_certs).await?;

        let ca_cert_pem_path = config.ca.join(CA_CERT_PEM_FILE);
        let ca_key_pem_path = config.ca.join(CA_KEY_PEM_FILE);

        let have_ca = tokio::fs::try_exists(&ca_cert_pem_path).await?
            && tokio::fs::try_exists(&ca_key_pem_path).await?;

        let ca_key = if have_ca {
            let key_pem = tokio::fs::read_to_string(&ca_key_pem_path).await?;
            KeyPair::from_pem(&key_pem)?
        } else {
            Self::create_ca(&config.ca, &ca_cert_pem_path, &ca_key_pem_path).await?
        };

        let revoked = Self::load_revoked_log(&config.ca).await?;
        let certs = Self::load_user_certs(&config.user_certs, &revoked).await?;
        let (crl_number, crl_next_update) = Self::current_crl_metadata(&config.ca).await?;

        Ok(Self {
            config,
            inner: RwLock::new(Inner {
                ca_key,
                certs,
                crl_number,
                crl_next_update,
            }),
        })
    }

    /// Generates a new self-signed CA key/cert plus an initial, empty CRL.
    /// Everything is written as PEM — no DER copy is kept on disk, since
    /// `KeyPair::from_pem` and `ca_params_template()` are enough to fully
    /// reconstruct signing capability on the next restart.
    async fn create_ca(
        ca_dir: &Path,
        cert_pem_path: &Path,
        key_pem_path: &Path,
    ) -> Result<KeyPair, CertError> {
        let mut params = ca_params_template()?;
        let now = OffsetDateTime::now_utc();
        params.not_before = now - Duration::days(1);
        params.not_after = now + CA_VALIDITY;

        let key_pair = KeyPair::generate()?;
        let cert = params.self_signed(&key_pair)?; // `&self` — params still usable below

        tokio::fs::write(cert_pem_path, cert.pem()).await?;
        tokio::fs::write(key_pem_path, key_pair.serialize_pem()).await?;

        // Issue the initial, empty CRL so crl.pem / crl.number exist from the start.
        let issuer = Issuer::from_params(&params, &key_pair);
        let crl_now = OffsetDateTime::now_utc();
        let next_update = crl_now + CRL_VALIDITY;
        let crl_params = CertificateRevocationListParams {
            this_update: crl_now,
            next_update,
            crl_number: SerialNumber::from(1u64),
            issuing_distribution_point: None,
            revoked_certs: Vec::new(),
            key_identifier_method: KeyIdMethod::Sha256,
        };
        let crl = crl_params.signed_by(&issuer)?;

        tokio::fs::write(ca_dir.join(CRL_PEM_FILE), crl.pem()?).await?;
        tokio::fs::write(ca_dir.join(CRL_NUMBER_FILE), b"1").await?;

        Ok(key_pair)
    }

    /// Reads the persisted CRL sequence number. We don't bother re-parsing
    /// crl.pem's own `next_update` back out on startup — `refresh_crl_if_due`
    /// is a "within margin" check, so starting as if a refresh is due costs
    /// at most one extra signature in the first hour after boot.
    async fn current_crl_metadata(ca_dir: &Path) -> Result<(u64, OffsetDateTime), CertError> {
        let number = match tokio::fs::read_to_string(ca_dir.join(CRL_NUMBER_FILE)).await {
            Ok(s) => s.trim().parse().unwrap_or(1),
            Err(_) => 1,
        };
        Ok((number, OffsetDateTime::now_utc()))
    }

    /// serial(hex) -> (cn, reason, revoked_at), read from the append-only log.
    async fn load_revoked_log(
        ca_dir: &Path,
    ) -> Result<HashMap<String, (String, RevocationReason, OffsetDateTime)>, CertError> {
        let mut revoked = HashMap::new();

        let Ok(contents) = tokio::fs::read_to_string(ca_dir.join(REVOKED_LOG_FILE)).await else {
            return Ok(revoked); // no revocations yet — file doesn't exist
        };

        for line in contents.lines() {
            let mut parts = line.splitn(4, '\t');
            let (Some(serial), Some(cn), Some(reason), Some(ts)) =
                (parts.next(), parts.next(), parts.next(), parts.next())
            else {
                continue; // skip malformed lines rather than fail startup
            };
            let Ok(reason_code) = reason.parse::<u8>() else {
                continue;
            };
            let Ok(unix) = ts.parse::<i64>() else {
                continue;
            };
            let Ok(at) = OffsetDateTime::from_unix_timestamp(unix) else {
                continue;
            };

            revoked.insert(
                serial.to_string(),
                (cn.to_string(), reason_from_code(reason_code), at),
            );
        }

        Ok(revoked)
    }

    /// Scans `dir` for `.der` client certs, extracts CN + serial from each,
    /// and cross-references `revoked` to set the right initial status.
    async fn load_user_certs(
        dir: &Path,
        revoked: &HashMap<String, (String, RevocationReason, OffsetDateTime)>,
    ) -> Result<HashMap<String, UserCert>, CertError> {
        let mut entries = tokio::fs::read_dir(dir).await?;
        let mut certs = HashMap::new();

        while let Some(entry) = entries.next_entry().await? {
            if !entry.file_name().to_string_lossy().ends_with(".der") {
                continue;
            }

            let path = entry.path();
            let bytes = tokio::fs::read(&path).await?;
            let (_, cert) = X509Certificate::from_der(&bytes)?;

            let Some(cn) = cert
                .subject()
                .iter_attributes()
                .find(|a| a.attr_type() == &OID_X509_COMMON_NAME)
                .and_then(|a| a.as_str().ok())
            else {
                println!("No CN found in subject of {path:?}, skipping");
                continue;
            };

            let serial = SerialNumber::from_slice(cert.raw_serial());
            let serial_hex = serial_to_hex(&serial);
            let validity = cert.validity();

            let status = match revoked.get(&serial_hex) {
                Some((_, reason, at)) => CertStatus::Revoked {
                    at: *at,
                    reason: *reason,
                },
                None => CertStatus::Active,
            };

            certs.insert(
                serial_hex,
                UserCert {
                    cn: cn.to_string(),
                    serial,
                    path,
                    issued_at: validity.not_before.to_datetime(),
                    not_after: validity.not_after.to_datetime(),
                    status,
                },
            );
        }

        Ok(certs)
    }

    /// Path nginx's `ssl_client_certificate` directive should point at.
    pub fn ca_cert_pem_path(&self) -> PathBuf {
        self.config.ca.join(CA_CERT_PEM_FILE)
    }

    /// Path nginx's `ssl_crl` directive should point at.
    pub fn crl_pem_path(&self) -> PathBuf {
        self.config.ca.join(CRL_PEM_FILE)
    }
}

// ---------------------------------------------------------------------------
// Issuance
// ---------------------------------------------------------------------------

impl CertManager {
    pub async fn issue_cert(&self, cn: &str) -> Result<IssuedCert, CertError> {
        let mut inner = self.inner.write().await;

        let mut params = CertificateParams::new(Vec::<String>::new())?;
        let mut dn = DistinguishedName::new();
        dn.push(DnType::CommonName, cn);
        params.distinguished_name = dn;
        params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
        params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ClientAuth];

        let now = OffsetDateTime::now_utc();
        let not_after = now + USER_CERT_VALIDITY;
        params.not_before = now - Duration::days(1);
        params.not_after = not_after;

        let key_pair = KeyPair::generate()?;
        let ca_params = ca_params_template()?;
        let issuer = Issuer::from_params(&ca_params, &inner.ca_key);
        let cert = params.signed_by(&key_pair, &issuer)?;
        let cert_der = cert.der().to_vec();

        // Re-derive the serial the same way load_user_certs() does, so there's
        // exactly one code path for "what serial does this cert have".
        let (_, parsed) = X509Certificate::from_der(&cert_der)?;
        let serial = SerialNumber::from_slice(parsed.raw_serial());
        let serial_hex = serial_to_hex(&serial);

        let path = self.config.user_certs.join(format!("{serial_hex}.der"));
        tokio::fs::write(&path, &cert_der).await?;

        inner.certs.insert(
            serial_hex.clone(),
            UserCert {
                cn: cn.to_string(),
                serial,
                path,
                issued_at: now,
                not_after,
                status: CertStatus::Active,
            },
        );

        Ok(IssuedCert {
            cn: cn.to_string(),
            serial: serial_hex,
            cert_pem: cert.pem(),
            key_pem: key_pair.serialize_pem(),
        })
    }
}

// ---------------------------------------------------------------------------
// Revocation + CRL signing
// ---------------------------------------------------------------------------

impl CertManager {
    pub async fn revoke_cert(
        &self,
        serial_hex: &str,
        reason: RevocationReason,
    ) -> Result<(), CertError> {
        let mut inner = self.inner.write().await;

        let cn = {
            let Some(entry) = inner.certs.get_mut(serial_hex) else {
                return Err(CertError::NotFound(serial_hex.to_string()));
            };
            if matches!(entry.status, CertStatus::Revoked { .. }) {
                return Ok(()); // already revoked — idempotent
            }
            entry.status = CertStatus::Revoked {
                at: OffsetDateTime::now_utc(),
                reason,
            };
            entry.cn.clone()
        };

        self.append_revocation_log(serial_hex, &cn, reason).await?;
        self.resign_crl(&mut inner).await?;

        drop(inner); // release the lock before shelling out to systemctl
        self.reload_nginx().await
    }

    async fn append_revocation_log(
        &self,
        serial_hex: &str,
        cn: &str,
        reason: RevocationReason,
    ) -> Result<(), CertError> {
        let path = self.config.ca.join(REVOKED_LOG_FILE);
        let mut file = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .await?;

        let line = format!(
            "{serial_hex}\t{cn}\t{}\t{}\n",
            reason_to_code(reason),
            OffsetDateTime::now_utc().unix_timestamp(),
        );
        file.write_all(line.as_bytes()).await?;
        Ok(())
    }

    /// Re-signs the CRL from whatever's currently marked `Revoked` in
    /// `inner.certs`. That map is always in sync with `revoked.log` — both
    /// are updated in the same critical section in `revoke_cert` — so this
    /// is safe to call from both revocation and the scheduled refresh below
    /// without re-reading the log file.
    async fn resign_crl(&self, inner: &mut Inner) -> Result<(), CertError> {
        let revoked_certs: Vec<RevokedCertParams> = inner
            .certs
            .values()
            .filter_map(|c| match &c.status {
                CertStatus::Revoked { at, reason } => Some(RevokedCertParams {
                    serial_number: c.serial.clone(),
                    revocation_time: *at,
                    reason_code: Some(*reason),
                    invalidity_date: None,
                }),
                CertStatus::Active => None,
            })
            .collect();

        inner.crl_number += 1;
        tokio::fs::write(
            self.config.ca.join(CRL_NUMBER_FILE),
            inner.crl_number.to_string(),
        )
        .await?;

        let ca_params = ca_params_template()?;
        let issuer = Issuer::from_params(&ca_params, &inner.ca_key);

        let now = OffsetDateTime::now_utc();
        let next_update = now + CRL_VALIDITY;
        let crl_params = CertificateRevocationListParams {
            this_update: now,
            next_update,
            crl_number: SerialNumber::from(inner.crl_number),
            issuing_distribution_point: None,
            revoked_certs,
            key_identifier_method: KeyIdMethod::Sha256,
        };
        let crl = crl_params.signed_by(&issuer)?;

        // Write to a temp file and rename over the target — atomic on the same
        // filesystem, so nginx never reads a partially-written CRL on reload.
        let final_path = self.crl_pem_path();
        let tmp_path = final_path.with_extension("pem.tmp");
        tokio::fs::write(&tmp_path, crl.pem()?).await?;
        tokio::fs::rename(&tmp_path, &final_path).await?;

        inner.crl_next_update = next_update;
        Ok(())
    }

    /// Triggers `systemctl reload nginx` — assumes polkit is already
    /// configured to authorize this specific unit + verb for this process's user.
    async fn reload_nginx(&self) -> Result<(), CertError> {
        if self.config.reload_nginx {
            let status = tokio::process::Command::new("systemctl")
                .args(["reload", "nginx"])
                .status()
                .await?;

            if !status.success() {
                return Err(CertError::Reload(status.code()));
            }
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Scheduled CRL refresh
// ---------------------------------------------------------------------------

impl CertManager {
    /// Spawns a background task that keeps the CRL from going stale even
    /// when nothing new is revoked. Call once after wrapping the manager:
    ///
    /// ```ignore
    /// let cm = Arc::new(CertManager::new(config).await?);
    /// cm.clone().spawn_crl_refresh_task();
    /// ```
    pub fn spawn_crl_refresh_task(self: Arc<Self>) {
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(CRL_CHECK_INTERVAL);
            loop {
                ticker.tick().await;
                if let Err(e) = self.refresh_crl_if_due().await {
                    eprintln!("scheduled CRL refresh failed: {e}");
                }
            }
        });
    }

    /// Checked on a cheap, regular cadence rather than sleeping until an
    /// exact deadline computed once: a revoke() in between would move
    /// `next_update` further out and leave a precomputed sleep targeting a
    /// stale time. Re-checking "are we within the margin?" sidesteps needing
    /// to wake this task early from revoke_cert().
    async fn refresh_crl_if_due(&self) -> Result<(), CertError> {
        let mut inner = self.inner.write().await;

        if OffsetDateTime::now_utc() + CRL_REFRESH_MARGIN < inner.crl_next_update {
            return Ok(()); // not due yet
        }

        self.resign_crl(&mut inner).await?;
        drop(inner);
        self.reload_nginx().await
    }
}

// ---------------------------------------------------------------------------
// Admin panel
// ---------------------------------------------------------------------------

impl CertManager {
    /// One entry per CN that has ever had a cert issued, each with its full
    /// cert history (newest first) and current status — active or revoked.
    pub async fn list_users(&self) -> Vec<UserSummary> {
        let inner = self.inner.read().await;

        let mut by_cn: HashMap<String, Vec<CertSummary>> = HashMap::new();
        for cert in inner.certs.values() {
            by_cn.entry(cert.cn.clone()).or_default().push(CertSummary {
                serial: serial_to_hex(&cert.serial),
                issued_at: cert.issued_at,
                not_after: cert.not_after,
                status: cert.status.clone(),
            });
        }

        by_cn
            .into_iter()
            .map(|(cn, mut certs)| {
                certs.sort_by_key(|c| Reverse(c.issued_at));
                UserSummary { cn, certs }
            })
            .collect()
    }
}
