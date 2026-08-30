//! ValKhana-owned secret abstraction.
//!
//! This crate intentionally contains no plaintext-file fallback and never reads vendor-owned
//! Claude, Codex, or Hermes credential locations. On Linux, ValKhana uses the freedesktop Secret
//! Service API with an encrypted D-Bus session. Secret-backed capabilities fail closed when the
//! service or its default collection is unavailable or locked.

use std::{collections::HashMap, fmt};

use anyhow::{Context, Result, bail};
use hmac::{Hmac, Mac};
use secret_service::{EncryptionType, blocking::SecretService};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use subtle::ConstantTimeEq;
use zeroize::Zeroize;

const MAX_SECRET_BYTES: usize = 64 * 1024;
const MIN_SERVICE_TOKEN_BYTES: usize = 32;
const MAX_SERVICE_TOKEN_BYTES: usize = 512;
const APPLICATION_ATTRIBUTE: &str = "application";
const APPLICATION_NAME: &str = "valkhana";
const SECRET_ID_ATTRIBUTE: &str = "valkhana-secret-id";
const SECRET_CLASS_ATTRIBUTE: &str = "valkhana-secret-class";
const SECRET_CONTENT_TYPE: &str = "application/octet-stream";
const SERVICE_REQUEST_VERSION: &str = "valkhana-service-request-v1";
pub const DASHBOARD_CURRENT_KEY_ID: &str = "service:dashboard-core";
pub const DASHBOARD_PREVIOUS_KEY_ID: &str = "service:dashboard-core-previous";
pub const DASHBOARD_REVOCATION_ID: &str = "service:dashboard-core-revoked";
pub const DASHBOARD_ROTATION_OVERLAP_MS: u64 = 5 * 60 * 1_000;
const DASHBOARD_KEY_ENVELOPE_VERSION: u8 = 1;

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct SecretId(String);

impl SecretId {
    pub fn parse(value: impl Into<String>) -> Result<Self> {
        let value = value.into();
        if value.is_empty()
            || value.len() > 200
            || !value.bytes().all(|byte| {
                byte.is_ascii_lowercase()
                    || byte.is_ascii_digit()
                    || matches!(byte, b':' | b'_' | b'-' | b'.')
            })
        {
            bail!("invalid ValKhana secret identifier");
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for SecretId {
    type Error = anyhow::Error;

    fn try_from(value: String) -> Result<Self> {
        Self::parse(value)
    }
}

impl From<SecretId> for String {
    fn from(value: SecretId) -> Self {
        value.0
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SecretClass {
    ServiceToken,
    RemoteUiCredential,
    ValkhanaIntegration,
}

impl SecretClass {
    fn as_str(self) -> &'static str {
        match self {
            Self::ServiceToken => "service_token",
            Self::RemoteUiCredential => "remote_ui_credential",
            Self::ValkhanaIntegration => "valkhana_integration",
        }
    }

    fn parse(value: &str) -> Result<Self> {
        match value {
            "service_token" => Ok(Self::ServiceToken),
            "remote_ui_credential" => Ok(Self::RemoteUiCredential),
            "valkhana_integration" => Ok(Self::ValkhanaIntegration),
            _ => bail!("invalid ValKhana secret class metadata"),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SecretMetadata {
    pub id: SecretId,
    pub class: SecretClass,
}

pub struct SecretValue(Vec<u8>);

impl SecretValue {
    pub fn new(value: impl Into<Vec<u8>>) -> Result<Self> {
        let value = value.into();
        if value.is_empty() || value.len() > MAX_SECRET_BYTES {
            bail!("ValKhana secret value must contain 1-{MAX_SECRET_BYTES} bytes");
        }
        Ok(Self(value))
    }

    pub fn expose(&self) -> &[u8] {
        &self.0
    }

    pub fn clear(&mut self) {
        self.0.zeroize();
    }
}

impl fmt::Debug for SecretValue {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SecretValue([REDACTED])")
    }
}

impl Drop for SecretValue {
    fn drop(&mut self) {
        self.clear();
    }
}

pub trait SecretStore: Send + Sync {
    fn get(&self, id: &SecretId) -> Result<Option<SecretValue>>;
    fn set(&self, metadata: &SecretMetadata, value: SecretValue) -> Result<()>;
    fn delete(&self, id: &SecretId) -> Result<bool>;
    fn list_metadata(&self) -> Result<Vec<SecretMetadata>>;
}

/// Linux Secret Service backend. Each operation creates a short-lived encrypted session so this
/// value remains `Send + Sync` and can safely be shared by Core without holding a D-Bus lifetime.
#[derive(Clone, Copy, Debug, Default)]
pub struct SecretServiceStore;

impl SecretServiceStore {
    /// Checks that Secret Service and its default collection are available and unlocked without
    /// reading, creating, or deleting any secret.
    pub fn probe(&self) -> Result<()> {
        self.with_collection(|_| Ok(()))
    }

    fn with_collection<T>(
        &self,
        operation: impl FnOnce(&secret_service::blocking::Collection<'_>) -> Result<T>,
    ) -> Result<T> {
        let service = SecretService::connect(EncryptionType::Dh)
            .context("connect to the encrypted Secret Service session")?;
        let collection = service
            .get_default_collection()
            .context("open the default Secret Service collection")?;
        collection
            .ensure_unlocked()
            .context("default Secret Service collection is locked")?;
        operation(&collection)
    }

    fn id_attributes(id: &SecretId) -> HashMap<&str, &str> {
        HashMap::from([
            (APPLICATION_ATTRIBUTE, APPLICATION_NAME),
            (SECRET_ID_ATTRIBUTE, id.as_str()),
        ])
    }

    fn metadata_attributes(metadata: &SecretMetadata) -> HashMap<&str, &str> {
        HashMap::from([
            (APPLICATION_ATTRIBUTE, APPLICATION_NAME),
            (SECRET_ID_ATTRIBUTE, metadata.id.as_str()),
            (SECRET_CLASS_ATTRIBUTE, metadata.class.as_str()),
        ])
    }

    fn metadata_from_attributes(attributes: &HashMap<String, String>) -> Result<SecretMetadata> {
        if attributes.get(APPLICATION_ATTRIBUTE).map(String::as_str) != Some(APPLICATION_NAME) {
            bail!("Secret Service item is outside the ValKhana namespace");
        }
        let id = attributes
            .get(SECRET_ID_ATTRIBUTE)
            .context("ValKhana Secret Service item is missing its identifier")?;
        let class = attributes
            .get(SECRET_CLASS_ATTRIBUTE)
            .context("ValKhana Secret Service item is missing its class")?;
        Ok(SecretMetadata {
            id: SecretId::parse(id.clone())?,
            class: SecretClass::parse(class)?,
        })
    }
}

impl SecretStore for SecretServiceStore {
    fn get(&self, id: &SecretId) -> Result<Option<SecretValue>> {
        self.with_collection(|collection| {
            let items = collection
                .search_items(Self::id_attributes(id))
                .context("search the ValKhana Secret Service namespace")?;
            match items.as_slice() {
                [] => Ok(None),
                [item] => {
                    let attributes = item
                        .get_attributes()
                        .context("read ValKhana secret metadata")?;
                    Self::metadata_from_attributes(&attributes)?;
                    let value = item
                        .get_secret()
                        .context("read the encrypted ValKhana secret")?;
                    Ok(Some(SecretValue::new(value)?))
                }
                _ => bail!("duplicate ValKhana Secret Service items for one identifier"),
            }
        })
    }

    fn set(&self, metadata: &SecretMetadata, value: SecretValue) -> Result<()> {
        self.with_collection(|collection| {
            let existing = collection
                .search_items(Self::id_attributes(&metadata.id))
                .context("search before writing the ValKhana secret")?;
            if existing.len() > 1 {
                bail!("duplicate ValKhana Secret Service items for one identifier");
            }
            if let Some(item) = existing.first() {
                let existing_metadata = Self::metadata_from_attributes(
                    &item
                        .get_attributes()
                        .context("read existing ValKhana secret metadata")?,
                )?;
                if existing_metadata.class != metadata.class {
                    bail!("cannot change the class of an existing ValKhana secret");
                }
            }

            let label = format!("ValKhana {}", metadata.id.as_str());
            collection
                .create_item(
                    &label,
                    Self::metadata_attributes(metadata),
                    value.expose(),
                    true,
                    SECRET_CONTENT_TYPE,
                )
                .context("write the encrypted ValKhana secret")?;
            Ok(())
        })
    }

    fn delete(&self, id: &SecretId) -> Result<bool> {
        self.with_collection(|collection| {
            let items = collection
                .search_items(Self::id_attributes(id))
                .context("search before deleting the ValKhana secret")?;
            if items.len() > 1 {
                bail!("duplicate ValKhana Secret Service items for one identifier");
            }
            let Some(item) = items.first() else {
                return Ok(false);
            };
            Self::metadata_from_attributes(
                &item
                    .get_attributes()
                    .context("read deleted ValKhana secret metadata")?,
            )?;
            item.delete().context("delete the ValKhana secret")?;
            Ok(true)
        })
    }

    fn list_metadata(&self) -> Result<Vec<SecretMetadata>> {
        self.with_collection(|collection| {
            let items = collection
                .search_items(HashMap::from([(APPLICATION_ATTRIBUTE, APPLICATION_NAME)]))
                .context("list the ValKhana Secret Service namespace")?;
            let mut metadata = items
                .iter()
                .map(|item| {
                    Self::metadata_from_attributes(
                        &item
                            .get_attributes()
                            .context("read listed ValKhana secret metadata")?,
                    )
                })
                .collect::<Result<Vec<_>>>()?;
            metadata.sort_by(|left, right| left.id.cmp(&right.id));
            if metadata.windows(2).any(|pair| pair[0].id == pair[1].id) {
                bail!("duplicate ValKhana Secret Service items for one identifier");
            }
            Ok(metadata)
        })
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct UnavailableSecretStore;

impl SecretStore for UnavailableSecretStore {
    fn get(&self, _id: &SecretId) -> Result<Option<SecretValue>> {
        bail!("ValKhana SecretStore backend is unavailable")
    }

    fn set(&self, _metadata: &SecretMetadata, _value: SecretValue) -> Result<()> {
        bail!("ValKhana SecretStore backend is unavailable")
    }

    fn delete(&self, _id: &SecretId) -> Result<bool> {
        bail!("ValKhana SecretStore backend is unavailable")
    }

    fn list_metadata(&self) -> Result<Vec<SecretMetadata>> {
        bail!("ValKhana SecretStore backend is unavailable")
    }
}

pub fn verify_service_token(
    store: &dyn SecretStore,
    id: &SecretId,
    presented: &[u8],
) -> Result<bool> {
    if !(MIN_SERVICE_TOKEN_BYTES..=MAX_SERVICE_TOKEN_BYTES).contains(&presented.len()) {
        return Ok(false);
    }
    let Some(expected) = store.get(id)? else {
        return Ok(false);
    };
    Ok(constant_time_eq(expected.expose(), presented))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ServiceRequest<'a> {
    pub service_id: &'a SecretId,
    pub method: &'a str,
    pub path: &'a str,
    pub action: &'a str,
    pub payload_sha256: [u8; 32],
    pub timestamp_unix_ms: u64,
    pub nonce: &'a str,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PreviousDashboardKeyEnvelope {
    version: u8,
    expires_at_unix_ms: u64,
    key_hex: String,
}

pub fn load_current_dashboard_service_key(store: &dyn SecretStore) -> Result<SecretValue> {
    if store
        .get(&SecretId::parse(DASHBOARD_REVOCATION_ID)?)?
        .is_some()
    {
        bail!("ValKhana dashboard service credential is revoked");
    }
    store
        .get(&SecretId::parse(DASHBOARD_CURRENT_KEY_ID)?)?
        .context("ValKhana dashboard service credential is not provisioned")
}

pub fn load_dashboard_service_keys(
    store: &dyn SecretStore,
    now_unix_ms: u64,
) -> Result<Vec<SecretValue>> {
    let current = load_current_dashboard_service_key(store)?;
    let mut keys = vec![current];
    let previous_id = SecretId::parse(DASHBOARD_PREVIOUS_KEY_ID)?;
    let Some(previous) = store.get(&previous_id)? else {
        return Ok(keys);
    };
    let envelope: PreviousDashboardKeyEnvelope = serde_json::from_slice(previous.expose())
        .context("decode previous dashboard key envelope")?;
    if envelope.version != DASHBOARD_KEY_ENVELOPE_VERSION {
        bail!("unsupported previous dashboard key envelope version");
    }
    if envelope.expires_at_unix_ms > now_unix_ms.saturating_add(DASHBOARD_ROTATION_OVERLAP_MS) {
        bail!("previous dashboard key overlap exceeds the maximum window");
    }
    if envelope.expires_at_unix_ms >= now_unix_ms {
        let key =
            hex::decode(&envelope.key_hex).context("decode previous dashboard service key")?;
        validate_service_request_key(&key)?;
        keys.push(SecretValue::new(key)?);
    }
    Ok(keys)
}

pub fn previous_dashboard_key_envelope(key: &[u8], expires_at_unix_ms: u64) -> Result<SecretValue> {
    validate_service_request_key(key)?;
    SecretValue::new(serde_json::to_vec(&PreviousDashboardKeyEnvelope {
        version: DASHBOARD_KEY_ENVELOPE_VERSION,
        expires_at_unix_ms,
        key_hex: hex::encode(key),
    })?)
}

pub fn provision_dashboard_service_key(store: &dyn SecretStore, key: SecretValue) -> Result<()> {
    validate_service_request_key(key.expose())?;
    let current_id = SecretId::parse(DASHBOARD_CURRENT_KEY_ID)?;
    if store.get(&current_id)?.is_some() {
        bail!("dashboard service key already exists; refusing to overwrite it");
    }
    store.set(&dashboard_key_metadata(current_id), key)?;
    store.delete(&SecretId::parse(DASHBOARD_PREVIOUS_KEY_ID)?)?;
    store.delete(&SecretId::parse(DASHBOARD_REVOCATION_ID)?)?;
    Ok(())
}

pub fn rotate_dashboard_service_key(
    store: &dyn SecretStore,
    key: SecretValue,
    now_unix_ms: u64,
) -> Result<u64> {
    validate_service_request_key(key.expose())?;
    let current = load_current_dashboard_service_key(store)?;
    let previous_id = SecretId::parse(DASHBOARD_PREVIOUS_KEY_ID)?;
    if store.get(&previous_id)?.is_some() {
        bail!("a dashboard key rotation is already pending finalization");
    }
    let expires_at = now_unix_ms.saturating_add(DASHBOARD_ROTATION_OVERLAP_MS);
    store.set(
        &dashboard_key_metadata(previous_id),
        previous_dashboard_key_envelope(current.expose(), expires_at)?,
    )?;
    store.set(
        &dashboard_key_metadata(SecretId::parse(DASHBOARD_CURRENT_KEY_ID)?),
        key,
    )?;
    Ok(expires_at)
}

pub fn finalize_dashboard_key_rotation(store: &dyn SecretStore) -> Result<bool> {
    store.delete(&SecretId::parse(DASHBOARD_PREVIOUS_KEY_ID)?)
}

pub fn revoke_dashboard_service_key(store: &dyn SecretStore) -> Result<()> {
    store.set(
        &dashboard_key_metadata(SecretId::parse(DASHBOARD_REVOCATION_ID)?),
        SecretValue::new(b"revoked".to_vec())?,
    )?;
    store.delete(&SecretId::parse(DASHBOARD_CURRENT_KEY_ID)?)?;
    store.delete(&SecretId::parse(DASHBOARD_PREVIOUS_KEY_ID)?)?;
    Ok(())
}

fn dashboard_key_metadata(id: SecretId) -> SecretMetadata {
    SecretMetadata {
        id,
        class: SecretClass::ServiceToken,
    }
}

pub fn sign_service_request(key: &[u8], request: &ServiceRequest<'_>) -> Result<String> {
    validate_service_request_key(key)?;
    let mut mac = Hmac::<Sha256>::new_from_slice(key).context("initialize service request HMAC")?;
    mac.update(canonical_service_request(request).as_bytes());
    Ok(hex::encode(mac.finalize().into_bytes()))
}

pub fn verify_service_request_signature(
    key: &[u8],
    request: &ServiceRequest<'_>,
    signature: &str,
) -> Result<bool> {
    validate_service_request_key(key)?;
    if signature.len() != 64
        || !signature
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Ok(false);
    }
    let signature = hex::decode(signature).context("decode service request signature")?;
    let mut mac = Hmac::<Sha256>::new_from_slice(key).context("initialize service request HMAC")?;
    mac.update(canonical_service_request(request).as_bytes());
    Ok(mac.verify_slice(&signature).is_ok())
}

fn validate_service_request_key(key: &[u8]) -> Result<()> {
    if !(MIN_SERVICE_TOKEN_BYTES..=MAX_SERVICE_TOKEN_BYTES).contains(&key.len()) {
        bail!("ValKhana service request key must contain 32-512 bytes");
    }
    Ok(())
}

fn canonical_service_request(request: &ServiceRequest<'_>) -> String {
    format!(
        "{SERVICE_REQUEST_VERSION}\n{}\n{}\n{}\n{}\n{}\n{}\n{}",
        request.service_id.as_str(),
        request.method,
        request.path,
        request.action,
        hex::encode(request.payload_sha256),
        request.timestamp_unix_ms,
        request.nonce,
    )
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    left.len() == right.len() && bool::from(left.ct_eq(right))
}

#[cfg(test)]
mod tests {
    use std::{collections::BTreeMap, sync::Mutex};

    use super::*;

    #[derive(Default)]
    struct MemoryStore(Mutex<BTreeMap<SecretId, (SecretClass, Vec<u8>)>>);

    impl SecretStore for MemoryStore {
        fn get(&self, id: &SecretId) -> Result<Option<SecretValue>> {
            self.0
                .lock()
                .unwrap()
                .get(id)
                .map(|(_, value)| SecretValue::new(value.clone()))
                .transpose()
        }

        fn set(&self, metadata: &SecretMetadata, value: SecretValue) -> Result<()> {
            self.0.lock().unwrap().insert(
                metadata.id.clone(),
                (metadata.class, value.expose().to_vec()),
            );
            Ok(())
        }

        fn delete(&self, id: &SecretId) -> Result<bool> {
            Ok(self.0.lock().unwrap().remove(id).is_some())
        }

        fn list_metadata(&self) -> Result<Vec<SecretMetadata>> {
            Ok(self
                .0
                .lock()
                .unwrap()
                .iter()
                .map(|(id, (class, _))| SecretMetadata {
                    id: id.clone(),
                    class: *class,
                })
                .collect())
        }
    }

    #[test]
    fn identifiers_and_values_are_bounded_and_redacted() {
        assert!(SecretId::parse("service:dashboard-core").is_ok());
        assert!(SecretId::parse("Vendor OAuth").is_err());
        assert!(SecretValue::new(Vec::new()).is_err());
        let mut value = SecretValue::new(b"must-not-print".to_vec()).unwrap();
        assert_eq!(format!("{value:?}"), "SecretValue([REDACTED])");
        value.clear();
        assert!(value.expose().iter().all(|byte| *byte == 0));
    }

    #[test]
    fn store_contract_returns_metadata_without_values() {
        let store = MemoryStore::default();
        let id = SecretId::parse("service:dashboard-core").unwrap();
        store
            .set(
                &SecretMetadata {
                    id: id.clone(),
                    class: SecretClass::ServiceToken,
                },
                SecretValue::new(vec![7; 32]).unwrap(),
            )
            .unwrap();
        assert_eq!(store.list_metadata().unwrap().len(), 1);
        assert_eq!(store.get(&id).unwrap().unwrap().expose(), &[7; 32]);
        assert!(store.delete(&id).unwrap());
        assert!(store.get(&id).unwrap().is_none());
    }

    #[test]
    fn service_token_verification_is_exact_and_backend_failure_is_closed() {
        let store = MemoryStore::default();
        let id = SecretId::parse("service:dashboard-core").unwrap();
        store
            .set(
                &SecretMetadata {
                    id: id.clone(),
                    class: SecretClass::ServiceToken,
                },
                SecretValue::new(vec![9; 32]).unwrap(),
            )
            .unwrap();
        assert!(verify_service_token(&store, &id, &[9; 32]).unwrap());
        assert!(!verify_service_token(&store, &id, &[8; 32]).unwrap());
        assert!(!verify_service_token(&store, &id, b"short").unwrap());
        assert!(verify_service_token(&UnavailableSecretStore, &id, &[9; 32]).is_err());
    }

    #[test]
    fn service_request_signatures_are_bound_to_every_canonical_field() {
        let service_id = SecretId::parse("service:valkhana-dashboard").unwrap();
        let request = ServiceRequest {
            service_id: &service_id,
            method: "PATCH",
            path: "/v1/integrations/hermes/tasks/t_123",
            action: "complete",
            payload_sha256: [7; 32],
            timestamp_unix_ms: 1_700_000_000_000,
            nonce: "00112233445566778899aabbccddeeff",
        };
        let key = [11; 32];
        let signature = sign_service_request(&key, &request).unwrap();
        assert_eq!(signature.len(), 64);
        assert!(verify_service_request_signature(&key, &request, &signature).unwrap());

        let different = ServiceRequest {
            action: "archive",
            ..request.clone()
        };
        assert!(!verify_service_request_signature(&key, &different, &signature).unwrap());
        assert!(!verify_service_request_signature(&[12; 32], &request, &signature).unwrap());
        assert!(!verify_service_request_signature(&key, &request, "not-a-signature").unwrap());
    }

    #[test]
    fn dashboard_key_rotation_is_bounded_and_revocation_is_immediate() {
        let store = MemoryStore::default();
        let metadata = |id| SecretMetadata {
            id: SecretId::parse(id).unwrap(),
            class: SecretClass::ServiceToken,
        };
        store
            .set(
                &metadata(DASHBOARD_CURRENT_KEY_ID),
                SecretValue::new(vec![41; 32]).unwrap(),
            )
            .unwrap();
        store
            .set(
                &metadata(DASHBOARD_PREVIOUS_KEY_ID),
                previous_dashboard_key_envelope(&[31; 32], 1_300_000).unwrap(),
            )
            .unwrap();

        let keys = load_dashboard_service_keys(&store, 1_000_000).unwrap();
        assert_eq!(keys.len(), 2);
        assert_eq!(keys[0].expose(), &[41; 32]);
        assert_eq!(keys[1].expose(), &[31; 32]);
        assert_eq!(
            load_dashboard_service_keys(&store, 1_300_001)
                .unwrap()
                .len(),
            1
        );

        store
            .set(
                &metadata(DASHBOARD_PREVIOUS_KEY_ID),
                previous_dashboard_key_envelope(&[31; 32], 1_300_001).unwrap(),
            )
            .unwrap();
        assert!(load_dashboard_service_keys(&store, 1_000_000).is_err());

        store
            .set(
                &metadata(DASHBOARD_REVOCATION_ID),
                SecretValue::new(b"revoked".to_vec()).unwrap(),
            )
            .unwrap();
        assert!(load_current_dashboard_service_key(&store).is_err());
        assert!(load_dashboard_service_keys(&store, 1_000_000).is_err());
    }

    #[test]
    fn dashboard_key_operator_lifecycle_has_bounded_overlap_and_reprovisioning() {
        let store = MemoryStore::default();
        provision_dashboard_service_key(&store, SecretValue::new(vec![11; 32]).unwrap()).unwrap();
        assert_eq!(
            load_current_dashboard_service_key(&store).unwrap().expose(),
            &[11; 32]
        );
        assert!(
            provision_dashboard_service_key(&store, SecretValue::new(vec![12; 32]).unwrap())
                .is_err()
        );

        let expires = rotate_dashboard_service_key(
            &store,
            SecretValue::new(vec![21; 32]).unwrap(),
            2_000_000,
        )
        .unwrap();
        assert_eq!(expires, 2_000_000 + DASHBOARD_ROTATION_OVERLAP_MS);
        let keys = load_dashboard_service_keys(&store, 2_000_001).unwrap();
        assert_eq!(keys[0].expose(), &[21; 32]);
        assert_eq!(keys[1].expose(), &[11; 32]);
        assert!(
            rotate_dashboard_service_key(
                &store,
                SecretValue::new(vec![31; 32]).unwrap(),
                2_000_001,
            )
            .is_err()
        );
        assert!(finalize_dashboard_key_rotation(&store).unwrap());
        assert_eq!(
            load_dashboard_service_keys(&store, 2_000_001)
                .unwrap()
                .len(),
            1
        );

        revoke_dashboard_service_key(&store).unwrap();
        assert!(load_current_dashboard_service_key(&store).is_err());
        provision_dashboard_service_key(&store, SecretValue::new(vec![41; 32]).unwrap()).unwrap();
        assert_eq!(
            load_current_dashboard_service_key(&store).unwrap().expose(),
            &[41; 32]
        );
    }

    #[test]
    fn secret_service_metadata_rejects_foreign_and_malformed_items() {
        let valid = HashMap::from([
            (
                APPLICATION_ATTRIBUTE.to_owned(),
                APPLICATION_NAME.to_owned(),
            ),
            (
                SECRET_ID_ATTRIBUTE.to_owned(),
                "service:dashboard-core".to_owned(),
            ),
            (
                SECRET_CLASS_ATTRIBUTE.to_owned(),
                "service_token".to_owned(),
            ),
        ]);
        assert_eq!(
            SecretServiceStore::metadata_from_attributes(&valid).unwrap(),
            SecretMetadata {
                id: SecretId::parse("service:dashboard-core").unwrap(),
                class: SecretClass::ServiceToken,
            }
        );

        let mut foreign = valid.clone();
        foreign.insert(APPLICATION_ATTRIBUTE.to_owned(), "other-app".to_owned());
        assert!(SecretServiceStore::metadata_from_attributes(&foreign).is_err());

        let mut malformed = valid;
        malformed.insert(
            SECRET_CLASS_ATTRIBUTE.to_owned(),
            "vendor_credential".to_owned(),
        );
        assert!(SecretServiceStore::metadata_from_attributes(&malformed).is_err());
    }

    #[test]
    #[ignore = "requires a running, unlocked desktop Secret Service"]
    fn live_secret_service_probe_is_read_only() {
        SecretServiceStore.probe().unwrap();
    }

    #[test]
    #[ignore = "creates and deletes a disposable item in the desktop Secret Service"]
    fn live_secret_service_lifecycle_cleans_up() {
        struct Cleanup<'a> {
            store: &'a SecretServiceStore,
            id: &'a SecretId,
        }
        impl Drop for Cleanup<'_> {
            fn drop(&mut self) {
                let _ = self.store.delete(self.id);
            }
        }

        let store = SecretServiceStore;
        let id = SecretId::parse(format!("test:secret-store-{}", std::process::id())).unwrap();
        let cleanup = Cleanup {
            store: &store,
            id: &id,
        };
        let _ = store.delete(&id);
        let metadata = SecretMetadata {
            id: id.clone(),
            class: SecretClass::ServiceToken,
        };

        store
            .set(&metadata, SecretValue::new(vec![17; 32]).unwrap())
            .unwrap();
        assert_eq!(store.get(&id).unwrap().unwrap().expose(), &[17; 32]);
        assert!(store.list_metadata().unwrap().contains(&metadata));

        store
            .set(&metadata, SecretValue::new(vec![23; 32]).unwrap())
            .unwrap();
        assert_eq!(store.get(&id).unwrap().unwrap().expose(), &[23; 32]);
        assert!(store.delete(&id).unwrap());
        assert!(store.get(&id).unwrap().is_none());
        std::mem::forget(cleanup);
    }
}
