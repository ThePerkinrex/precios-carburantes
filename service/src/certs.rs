//! Manages the mTLS CA: issues and revokes client certificates, keeps the
//! CRL current, and reloads nginx so it picks up changes.
//!
//! Files on disk, all under `CertConfig::ca`:
//!   ca-cert.pem   — CA cert.        nginx: `ssl_client_certificate`
//!   ca-key.pem    — CA private key (PKCS#8). Never leaves this directory.
//!   crl.pem       — current CRL.    nginx: `ssl_crl`
//!   crl.number    — monotonic CRL sequence number, bumped on every re-sign.
//!   revoked.log   — append-only revocation record: serial, cn, reason, timestamp.
//!                   The durable source of truth for what belongs in the CRL.
//!
//! Issued client certs live under `CertConfig::user_certs` as `<serial-hex>.der`.
//! Each cert's subject is `CN=<user>, OU=<device label>`. Certs without an OU
//! (the ones made by the old OpenSSL scripts) get the label `legacy`.
//!
//! The CA may be one created here or an imported existing one (e.g. the old
//! OpenSSL `carburantes-CA`). Signing always goes through
//! `Issuer::from_ca_cert_pem`, so issued certs and CRLs carry the CA's real
//! DN and its actual Subject Key Identifier as their AKI — whatever hash the
//! CA was created with.

use std::{
    cmp::Reverse,
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration as StdDuration,
};

use p12_keystore::{
    Certificate as P12Certificate, EncryptionAlgorithm, KeyStore, KeyStoreEntry, MacAlgorithm,
    PrivateKey as P12PrivateKey, PrivateKeyChain,
};
use rcgen::{
    BasicConstraints, CertificateParams, CertificateRevocationListParams, DistinguishedName,
    DnType, ExtendedKeyUsagePurpose, IsCa, Issuer, KeyIdMethod, KeyPair, KeyUsagePurpose,
    RevocationReason, RevokedCertParams, SerialNumber,
};
use thiserror::Error;
use time::{Duration, OffsetDateTime};
use tokio::{io::AsyncWriteExt, sync::RwLock};
use tracing::{error, info, warn};
use x509_parser::{
    asn1_rs::FromDer,
    certificate::X509Certificate,
    extensions::ParsedExtension,
    oid_registry::{OID_X509_COMMON_NAME, OID_X509_ORGANIZATIONAL_UNIT},
    pem::parse_x509_pem,
    revocation_list::CertificateRevocationList,
    x509::X509Name,
};

use crate::config::CertConfig;

#[derive(Debug, Error)]
pub enum CertError {
    #[error("IO error: {0}")]
    IO(#[from] std::io::Error),
    #[error("X509 parse error: {0}")]
    X509(#[from] x509_parser::asn1_rs::Err<x509_parser::error::X509Error>),
    #[error("PEM parse error: {0}")]
    Pem(#[from] x509_parser::asn1_rs::Err<x509_parser::error::PEMError>),
    #[error("certificate generation error: {0}")]
    Rcgen(#[from] rcgen::Error),
    #[error("PKCS#12 error: {0}")]
    P12(#[from] p12_keystore::error::Error),
    #[error("no cert found for serial {0}")]
    NotFound(String),
    #[error("invalid name {0:?}: use 1-32 of a-z, 0-9, '-' and '_'")]
    InvalidName(String),
    #[error("{cn} already has an active cert labelled {label:?}")]
    LabelInUse { cn: String, label: String },
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

/// Label for certs issued before labels existed (no OU in the subject).
pub const LEGACY_LABEL: &str = "legacy";

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
    pub label: String,
    pub serial: SerialNumber,
    pub issued_at: OffsetDateTime,
    pub not_after: OffsetDateTime,
    pub status: CertStatus,
}

impl UserCert {
    /// Usable right now: not revoked and not expired.
    pub fn is_active(&self) -> bool {
        matches!(self.status, CertStatus::Active) && self.not_after > OffsetDateTime::now_utc()
    }
}

/// Admin-panel view: one entry per CN, with every cert ever issued to it.
pub struct UserSummary {
    pub cn: String,
    pub certs: Vec<CertSummary>,
}

pub struct CertSummary {
    pub serial: String,
    pub label: String,
    pub issued_at: OffsetDateTime,
    pub not_after: OffsetDateTime,
    pub status: CertStatus,
}

impl From<&UserCert> for CertSummary {
    fn from(cert: &UserCert) -> Self {
        Self {
            serial: serial_to_hex(&cert.serial),
            label: cert.label.clone(),
            issued_at: cert.issued_at,
            not_after: cert.not_after,
            status: cert.status.clone(),
        }
    }
}

/// A freshly issued cert, bundled for delivery. The private key only ever
/// exists inside this (password-encrypted) PKCS#12 blob.
pub struct IssuedP12 {
    pub serial: String,
    pub p12: Vec<u8>,
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

/// Everything that changes at runtime, behind one lock. Reads (auth lookups,
/// admin listing) take a read lock; issue/revoke/refresh take a write lock.
/// `tokio::sync::RwLock` specifically, not `std::sync` — issue/revoke hold
/// the lock across `.await` points (file writes), which the std-lib lock
/// isn't safe for.
struct Inner {
    /// serial (normalized hex) -> cert record. Built from disk at startup,
    /// then kept in sync with `revoked.log` on every write — this map is what
    /// `resign_crl` reads from, so there's never a separate "is this actually
    /// revoked" check.
    certs: HashMap<String, UserCert>,
    crl_number: u64,
    crl_next_update: OffsetDateTime,
}

/// The CA's signing material. Immutable after startup, so it lives outside
/// the lock.
struct Ca {
    key: KeyPair,
    cert_pem: String,
    cert_der: Vec<u8>,
    /// The CA cert's Subject Key Identifier, used as the CRL's AKI. OpenSSL
    /// (and so nginx) only pairs a CRL with a CA when these match.
    key_id: KeyIdMethod,
}

impl Ca {
    fn issuer(&self) -> Result<Issuer<'static, &KeyPair>, CertError> {
        Ok(Issuer::from_ca_cert_pem(&self.cert_pem, &self.key)?)
    }
}

pub struct CertManager {
    config: CertConfig,
    ca: Ca,
    inner: RwLock<Inner>,
}

// ---------------------------------------------------------------------------
// Free helpers
// ---------------------------------------------------------------------------

/// Canonical serial form used as map key and in the API: lowercase hex with
/// no leading zero bytes. DER integers may carry a `00` sign byte that
/// nginx's `$ssl_client_serial` leaves out, so both sides go through here.
fn serial_to_hex(serial: &SerialNumber) -> String {
    let bytes = serial.as_ref();
    let start = bytes
        .iter()
        .position(|&b| b != 0)
        .unwrap_or(bytes.len().saturating_sub(1));
    bytes[start..].iter().map(|b| format!("{b:02x}")).collect()
}

/// Normalizes an externally supplied serial (nginx header, URL path) to the
/// same form as `serial_to_hex`.
pub fn normalize_serial(serial: &str) -> String {
    let hex: String = serial
        .chars()
        .filter(|c| c.is_ascii_hexdigit())
        .map(|c| c.to_ascii_lowercase())
        .collect();
    let mut s = hex.as_str();
    if s.len() % 2 == 1 {
        // Odd length can't come from us; keep it as-is minus zero padding.
        return s.trim_start_matches('0').to_string();
    }
    while s.len() > 2 && s.starts_with("00") {
        s = &s[2..];
    }
    s.to_string()
}

/// CNs and labels end up in DNs, headers, filenames and URLs, so keep them
/// boring.
pub fn validate_name(name: &str) -> Result<(), CertError> {
    let ok = (1..=32).contains(&name.len())
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_');
    if ok {
        Ok(())
    } else {
        Err(CertError::InvalidName(name.to_string()))
    }
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

fn name_attr(name: &X509Name<'_>, oid: &x509_parser::oid_registry::Oid<'_>) -> Option<String> {
    name.iter_attributes()
        .find(|a| a.attr_type() == oid)
        .and_then(|a| a.as_str().ok())
        .map(str::to_string)
}

fn subject_key_id(cert: &X509Certificate<'_>) -> Option<Vec<u8>> {
    cert.iter_extensions()
        .find_map(|ext| match ext.parsed_extension() {
            ParsedExtension::SubjectKeyIdentifier(id) => Some(id.0.to_vec()),
            _ => None,
        })
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

        if !have_ca {
            info!(
                "No CA found in {:?}, creating {:?}",
                config.ca, config.ca_name
            );
            Self::create_ca(&config.ca_name, &ca_cert_pem_path, &ca_key_pem_path).await?;
        }

        let ca = Self::load_ca(&ca_cert_pem_path, &ca_key_pem_path).await?;
        let revoked = Self::load_revoked_log(&config.ca).await?;
        let certs = Self::load_user_certs(&config.user_certs, &revoked).await?;
        let crl_number = Self::load_crl_number(&config.ca).await;
        let crl_next_update = Self::load_crl_next_update(&config.ca).await;

        info!(
            "Loaded {} client certs from {:?}",
            certs.len(),
            config.user_certs
        );

        let manager = Self {
            config,
            ca,
            inner: RwLock::new(Inner {
                certs,
                crl_number,
                crl_next_update: crl_next_update.unwrap_or_else(OffsetDateTime::now_utc),
            }),
        };

        // Fresh CA, or an imported one that never had a CRL: nginx refuses to
        // verify anything under `ssl_crl` without one, so sign it right away.
        if crl_next_update.is_none() {
            info!("No readable CRL, signing one");
            let mut inner = manager.inner.write().await;
            manager.resign_crl(&mut inner).await?;
        }

        Ok(manager)
    }

    /// Generates a new self-signed CA key/cert. The CRL is created by `new`
    /// afterwards, through the same path as for an imported CA.
    async fn create_ca(
        ca_name: &str,
        cert_pem_path: &Path,
        key_pem_path: &Path,
    ) -> Result<(), CertError> {
        let mut params = CertificateParams::new(Vec::<String>::new())?;
        params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        params.key_usages = vec![
            KeyUsagePurpose::KeyCertSign,
            KeyUsagePurpose::CrlSign,
            KeyUsagePurpose::DigitalSignature,
        ];
        let mut dn = DistinguishedName::new();
        dn.push(DnType::CommonName, ca_name);
        params.distinguished_name = dn;

        let now = OffsetDateTime::now_utc();
        params.not_before = now - Duration::days(1);
        params.not_after = now + CA_VALIDITY;

        let key_pair = KeyPair::generate()?;
        let cert = params.self_signed(&key_pair)?;

        write_private(key_pem_path, key_pair.serialize_pem().as_bytes()).await?;
        tokio::fs::write(cert_pem_path, cert.pem()).await?;
        Ok(())
    }

    async fn load_ca(cert_pem_path: &Path, key_pem_path: &Path) -> Result<Ca, CertError> {
        let cert_pem = tokio::fs::read_to_string(cert_pem_path).await?;
        let key_pem = tokio::fs::read_to_string(key_pem_path).await?;
        let key = KeyPair::from_pem(&key_pem)?;

        let (_, pem) = parse_x509_pem(cert_pem.as_bytes())?;
        let cert_der = pem.contents;
        let (_, cert) = X509Certificate::from_der(&cert_der)?;
        let key_id = match subject_key_id(&cert) {
            Some(id) => KeyIdMethod::PreSpecified(id),
            None => {
                warn!("CA cert has no Subject Key Identifier; CRL AKI may not match");
                KeyIdMethod::Sha256
            }
        };
        info!("Loaded CA {}", cert.subject());

        Ok(Ca {
            key,
            cert_pem,
            cert_der,
            key_id,
        })
    }

    async fn load_crl_number(ca_dir: &Path) -> u64 {
        match tokio::fs::read_to_string(ca_dir.join(CRL_NUMBER_FILE)).await {
            Ok(s) => s.trim().parse().unwrap_or(1),
            Err(_) => 1,
        }
    }

    /// `next_update` of the CRL currently on disk, or `None` if there's no
    /// readable one. Knowing it avoids a pointless re-sign + nginx reload on
    /// every service restart.
    async fn load_crl_next_update(ca_dir: &Path) -> Option<OffsetDateTime> {
        let bytes = tokio::fs::read(ca_dir.join(CRL_PEM_FILE)).await.ok()?;
        let (_, pem) = parse_x509_pem(&bytes).ok()?;
        let (_, crl) = CertificateRevocationList::from_der(&pem.contents).ok()?;
        crl.next_update().map(|t| t.to_datetime())
    }

    /// serial(normalized hex) -> (cn, reason, revoked_at), read from the
    /// append-only log.
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
                normalize_serial(serial),
                (cn.to_string(), reason_from_code(reason_code), at),
            );
        }

        Ok(revoked)
    }

    /// Scans `dir` for `.der` client certs, extracts CN, label (OU) and serial
    /// from each, and cross-references `revoked` to set the right initial status.
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

            let Some(cn) = name_attr(cert.subject(), &OID_X509_COMMON_NAME) else {
                warn!("No CN found in subject of {path:?}, skipping");
                continue;
            };
            let label = name_attr(cert.subject(), &OID_X509_ORGANIZATIONAL_UNIT)
                .unwrap_or_else(|| LEGACY_LABEL.to_string());

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
                    cn,
                    label,
                    serial,
                    issued_at: validity.not_before.to_datetime(),
                    not_after: validity.not_after.to_datetime(),
                    status,
                },
            );
        }

        Ok(certs)
    }

    /// Path nginx's `ssl_client_certificate` directive should point at.
    #[allow(dead_code)]
    pub fn ca_cert_pem_path(&self) -> PathBuf {
        self.config.ca.join(CA_CERT_PEM_FILE)
    }

    /// Path nginx's `ssl_crl` directive should point at.
    pub fn crl_pem_path(&self) -> PathBuf {
        self.config.ca.join(CRL_PEM_FILE)
    }
}

/// Writes a file readable only by the service user.
async fn write_private(path: &Path, contents: &[u8]) -> Result<(), CertError> {
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
        .await?;
    file.write_all(contents).await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

impl CertManager {
    /// The cert with this serial, in any status. Auth callers must still
    /// check `is_active()`.
    pub async fn lookup(&self, serial: &str) -> Option<UserCert> {
        let inner = self.inner.read().await;
        inner.certs.get(&normalize_serial(serial)).cloned()
    }

    /// Every cert ever issued to `cn`, newest first.
    pub async fn certs_for(&self, cn: &str) -> Vec<CertSummary> {
        let inner = self.inner.read().await;
        let mut certs: Vec<CertSummary> = inner
            .certs
            .values()
            .filter(|c| c.cn == cn)
            .map(CertSummary::from)
            .collect();
        certs.sort_by_key(|c| Reverse(c.issued_at));
        certs
    }

    /// Whether `label` can be given to a new cert for `cn`: labels are unique
    /// among a user's active certs. A renewal may keep the label of the cert
    /// it renews (both stay valid until the old one expires).
    pub async fn check_label_free(
        &self,
        cn: &str,
        label: &str,
        renewing: Option<&str>,
    ) -> Result<(), CertError> {
        let inner = self.inner.read().await;
        Self::check_label_free_locked(&inner, cn, label, renewing)
    }

    fn check_label_free_locked(
        inner: &Inner,
        cn: &str,
        label: &str,
        renewing: Option<&str>,
    ) -> Result<(), CertError> {
        validate_name(cn)?;
        validate_name(label)?;

        if let Some(old) = renewing.and_then(|s| inner.certs.get(&normalize_serial(s)))
            && old.cn == cn
            && old.label == label
        {
            return Ok(());
        }

        let taken = inner
            .certs
            .values()
            .any(|c| c.cn == cn && c.label == label && c.is_active());
        if taken {
            Err(CertError::LabelInUse {
                cn: cn.to_string(),
                label: label.to_string(),
            })
        } else {
            Ok(())
        }
    }
}

// ---------------------------------------------------------------------------
// Issuance
// ---------------------------------------------------------------------------

impl CertManager {
    /// Issues a client cert for `cn`/`label` and returns it bundled with its
    /// fresh private key and the CA cert as a PKCS#12 encrypted with
    /// `password`. Only the public cert is stored.
    ///
    /// `renewing` is the serial of the cert this one replaces, if any; see
    /// `check_label_free`.
    pub async fn issue_p12(
        &self,
        cn: &str,
        label: &str,
        renewing: Option<&str>,
        password: &str,
    ) -> Result<IssuedP12, CertError> {
        let mut inner = self.inner.write().await;
        Self::check_label_free_locked(&inner, cn, label, renewing)?;

        let mut params = CertificateParams::new(Vec::<String>::new())?;
        let mut dn = DistinguishedName::new();
        dn.push(DnType::CommonName, cn);
        dn.push(DnType::OrganizationalUnitName, label);
        params.distinguished_name = dn;
        params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
        params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ClientAuth];

        let now = OffsetDateTime::now_utc();
        let not_after = now + USER_CERT_VALIDITY;
        params.not_before = now - Duration::days(1);
        params.not_after = not_after;

        let key_pair = KeyPair::generate()?;
        let cert = params.signed_by(&key_pair, &self.ca.issuer()?)?;
        let cert_der = cert.der().to_vec();

        // Re-derive the serial the same way load_user_certs() does, so there's
        // exactly one code path for "what serial does this cert have".
        let (_, parsed) = X509Certificate::from_der(&cert_der)?;
        let serial = SerialNumber::from_slice(parsed.raw_serial());
        let serial_hex = serial_to_hex(&serial);

        let p12 = self.build_p12(cn, label, &serial_hex, &cert_der, &key_pair, password)?;

        let path = self.config.user_certs.join(format!("{serial_hex}.der"));
        tokio::fs::write(&path, &cert_der).await?;

        inner.certs.insert(
            serial_hex.clone(),
            UserCert {
                cn: cn.to_string(),
                label: label.to_string(),
                serial,
                issued_at: now,
                not_after,
                status: CertStatus::Active,
            },
        );

        info!("Issued cert {serial_hex} for {cn}/{label}");
        Ok(IssuedP12 {
            serial: serial_hex,
            p12,
        })
    }

    /// PBE-SHA1-3DES with an HMAC-SHA1 MAC: the one combination every
    /// importer handles (macOS Keychain and older iOS/Android reject the
    /// AES/SHA-256 default). The password is user-chosen and the file is a
    /// one-off download, so the weaker KDF is an acceptable trade.
    fn build_p12(
        &self,
        cn: &str,
        label: &str,
        serial_hex: &str,
        cert_der: &[u8],
        key_pair: &KeyPair,
        password: &str,
    ) -> Result<Vec<u8>, CertError> {
        let chain = PrivateKeyChain::new(
            serial_hex.as_bytes(),
            P12PrivateKey::from_der(&key_pair.serialize_der())?,
            [
                P12Certificate::from_der(cert_der)?,
                P12Certificate::from_der(&self.ca.cert_der)?,
            ],
        );

        let mut store = KeyStore::new();
        store.add_entry(
            &format!("carburantes {cn} ({label})"),
            KeyStoreEntry::PrivateKeyChain(chain),
        );

        Ok(store
            .writer(password)
            .encryption_algorithm(EncryptionAlgorithm::PbeWithShaAnd3KeyTripleDesCbc)
            .mac_algorithm(MacAlgorithm::HmacSha1)
            .write()?)
    }
}

// ---------------------------------------------------------------------------
// Revocation + CRL signing
// ---------------------------------------------------------------------------

impl CertManager {
    pub async fn revoke_cert(
        &self,
        serial: &str,
        reason: RevocationReason,
    ) -> Result<(), CertError> {
        let serial_hex = normalize_serial(serial);
        let mut inner = self.inner.write().await;

        let cn = {
            let Some(entry) = inner.certs.get_mut(&serial_hex) else {
                return Err(CertError::NotFound(serial_hex));
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

        self.append_revocation_log(&serial_hex, &cn, reason).await?;
        self.resign_crl(&mut inner).await?;
        info!("Revoked cert {serial_hex} of {cn} ({reason:?})");

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

        let now = OffsetDateTime::now_utc();
        let next_update = now + CRL_VALIDITY;
        let crl_params = CertificateRevocationListParams {
            this_update: now,
            next_update,
            crl_number: SerialNumber::from(inner.crl_number),
            issuing_distribution_point: None,
            revoked_certs,
            key_identifier_method: self.ca.key_id.clone(),
        };
        let crl = crl_params.signed_by(&self.ca.issuer()?)?;

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
                    error!("scheduled CRL refresh failed: {e}");
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

        info!("CRL close to next_update, re-signing");
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
            by_cn
                .entry(cert.cn.clone())
                .or_default()
                .push(CertSummary::from(cert));
        }

        let mut users: Vec<UserSummary> = by_cn
            .into_iter()
            .map(|(cn, mut certs)| {
                certs.sort_by_key(|c| Reverse(c.issued_at));
                UserSummary { cn, certs }
            })
            .collect();
        users.sort_by(|a, b| a.cn.cmp(&b.cn));
        users
    }
}

#[cfg(test)]
mod tests {
    use std::process::Command;

    use p12_keystore::Pkcs12ImportPolicy;

    use super::*;

    /// Throwaway CA + client cert made like the old OpenSSL scripts (RSA key,
    /// SHA-1 SKI, client CN without OU). See `testdata/legacy/generate.sh`.
    const LEGACY_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/testdata/legacy");

    fn test_config(dir: &Path) -> CertConfig {
        CertConfig {
            ca: dir.join("CA"),
            user_certs: dir.join("users"),
            ca_name: "test-CA".to_string(),
            ..CertConfig::default()
        }
    }

    /// Lays out the legacy fixture the way the deploy runbook does: CA files
    /// renamed into `CA/`, the client cert converted to DER in `users/`.
    fn import_legacy_fixture(config: &CertConfig) {
        let legacy = Path::new(LEGACY_DIR);
        std::fs::create_dir_all(&config.ca).unwrap();
        std::fs::create_dir_all(&config.user_certs).unwrap();
        std::fs::copy(legacy.join("ca.crt"), config.ca.join(CA_CERT_PEM_FILE)).unwrap();
        std::fs::copy(legacy.join("ca.key"), config.ca.join(CA_KEY_PEM_FILE)).unwrap();

        let pem = std::fs::read(legacy.join("client.crt")).unwrap();
        let (_, pem) = parse_x509_pem(&pem).unwrap();
        std::fs::write(config.user_certs.join("client.der"), pem.contents).unwrap();
    }

    fn has_openssl() -> bool {
        Command::new("openssl").arg("version").output().is_ok()
    }

    /// `openssl verify` against the CA and the current CRL — the same check
    /// nginx does with `ssl_client_certificate` + `ssl_crl`.
    fn openssl_verify(config: &CertConfig, cert_pem: &Path) -> bool {
        Command::new("openssl")
            .arg("verify")
            .arg("-CAfile")
            .arg(config.ca.join(CA_CERT_PEM_FILE))
            .arg("-crl_check")
            .arg("-CRLfile")
            .arg(config.ca.join(CRL_PEM_FILE))
            .arg(cert_pem)
            .output()
            .unwrap()
            .status
            .success()
    }

    /// Extracts the leaf cert from an issued P12 and writes it as PEM.
    fn leaf_pem_from_p12(p12: &[u8], password: &str, out: &Path) {
        let store = KeyStore::from_pkcs12(p12, password, Pkcs12ImportPolicy::Strict).unwrap();
        let (_, chain) = store.private_key_chain().unwrap();
        let der = chain.certs()[0].as_der();
        let pem = Command::new("openssl")
            .args(["x509", "-inform", "der"])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .and_then(|mut child| {
                use std::io::Write;
                child.stdin.take().unwrap().write_all(der)?;
                child.wait_with_output()
            })
            .unwrap();
        std::fs::write(out, pem.stdout).unwrap();
    }

    #[test]
    fn serial_normalization() {
        assert_eq!(normalize_serial("3ADD9E67"), "3add9e67");
        assert_eq!(normalize_serial("00:8a:01"), "8a01");
        assert_eq!(
            serial_to_hex(&SerialNumber::from_slice(&[0, 0x8a, 1])),
            "8a01"
        );
        assert_eq!(normalize_serial("00"), "00");
    }

    #[test]
    fn names() {
        assert!(validate_name("alice").is_ok());
        assert!(validate_name("bob-phone_2").is_ok());
        assert!(validate_name("").is_err());
        assert!(validate_name("Alice").is_err());
        assert!(validate_name("a,OU=x").is_err());
        assert!(validate_name(&"a".repeat(33)).is_err());
    }

    #[tokio::test]
    async fn issue_lookup_labels_revoke_reload() {
        let dir = tempfile::tempdir().unwrap();
        let cm = CertManager::new(test_config(dir.path())).await.unwrap();
        assert!(dir.path().join("CA/crl.pem").exists());

        let a = cm.issue_p12("alice", "laptop", None, "pw").await.unwrap();
        let store = KeyStore::from_pkcs12(&a.p12, "pw", Pkcs12ImportPolicy::Strict).unwrap();
        assert_eq!(store.private_key_chain().unwrap().1.certs().len(), 2);
        assert!(KeyStore::from_pkcs12(&a.p12, "wrong", Pkcs12ImportPolicy::Strict).is_err());

        // Lookups accept nginx's uppercase form.
        let cert = cm.lookup(&a.serial.to_uppercase()).await.unwrap();
        assert_eq!((cert.cn.as_str(), cert.label.as_str()), ("alice", "laptop"));
        assert!(cert.is_active());

        // Same label is taken; other users and other labels are fine.
        assert!(matches!(
            cm.issue_p12("alice", "laptop", None, "pw").await,
            Err(CertError::LabelInUse { .. })
        ));
        cm.issue_p12("alice", "phone", None, "pw").await.unwrap();
        cm.issue_p12("bob", "laptop", None, "pw").await.unwrap();

        // Renewal may keep its own label, repeatedly...
        let b = cm
            .issue_p12("alice", "laptop", Some(&a.serial), "pw")
            .await
            .unwrap();
        cm.issue_p12("alice", "laptop", Some(&b.serial), "pw")
            .await
            .unwrap();
        // ...but not steal another cert's label.
        assert!(matches!(
            cm.issue_p12("alice", "phone", Some(&a.serial), "pw").await,
            Err(CertError::LabelInUse { .. })
        ));

        // Revoking frees the label.
        let phone = cm
            .certs_for("alice")
            .await
            .into_iter()
            .find(|c| c.label == "phone")
            .unwrap();
        cm.revoke_cert(&phone.serial, RevocationReason::KeyCompromise)
            .await
            .unwrap();
        assert!(!cm.lookup(&phone.serial).await.unwrap().is_active());
        cm.issue_p12("alice", "phone", None, "pw").await.unwrap();

        // Everything survives a restart.
        drop(cm);
        let cm = CertManager::new(test_config(dir.path())).await.unwrap();
        assert_eq!(cm.certs_for("alice").await.len(), 5);
        assert!(!cm.lookup(&phone.serial).await.unwrap().is_active());
        assert_eq!(cm.list_users().await.len(), 2);
    }

    /// The migration path: an imported OpenSSL CA keeps signing, its CRL is
    /// accepted by OpenSSL, and pre-existing certs keep working until revoked.
    #[tokio::test]
    async fn imported_legacy_ca() {
        let dir = tempfile::tempdir().unwrap();
        let config = test_config(dir.path());
        import_legacy_fixture(&config);

        let cm = CertManager::new(config.clone()).await.unwrap();
        assert!(
            config.ca.join(CRL_PEM_FILE).exists(),
            "CRL created for imported CA"
        );

        let legacy = cm.certs_for("alice").await;
        assert_eq!(legacy.len(), 1);
        assert_eq!(legacy[0].label, LEGACY_LABEL);

        let issued = cm.issue_p12("alice", "phone", None, "pw").await.unwrap();

        if !has_openssl() {
            eprintln!("openssl not found, skipping chain/CRL verification");
            return;
        }
        let legacy_pem = Path::new(LEGACY_DIR).join("client.crt");
        let new_pem = dir.path().join("new.pem");
        leaf_pem_from_p12(&issued.p12, "pw", &new_pem);

        assert!(
            openssl_verify(&config, &legacy_pem),
            "legacy cert still valid"
        );
        assert!(
            openssl_verify(&config, &new_pem),
            "new cert chains to legacy CA"
        );

        cm.revoke_cert(&legacy[0].serial, RevocationReason::Superseded)
            .await
            .unwrap();
        assert!(
            !openssl_verify(&config, &legacy_pem),
            "revoked legacy cert rejected"
        );
        assert!(openssl_verify(&config, &new_pem), "other certs unaffected");
    }
}
