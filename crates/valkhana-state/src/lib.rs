//! Durable Rust authority for ValKhana system-control state.
//!
//! This deliberately does not model Hermes task status or write Hermes storage.

use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result, bail};
use fs2::FileExt;
use serde::{Deserialize, Serialize};

pub const STATE_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AutomationState {
    Active,
    Pausing,
    Paused,
    Recovery,
    Stopped,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AutomationStateDocument {
    pub schema_version: u32,
    pub state: AutomationState,
}

impl Default for AutomationStateDocument {
    fn default() -> Self {
        Self {
            schema_version: STATE_SCHEMA_VERSION,
            state: AutomationState::Stopped,
        }
    }
}

#[derive(Debug, Clone)]
pub struct StateStore {
    policy_dir: PathBuf,
}

impl StateStore {
    pub fn new(state_dir: &Path) -> Result<Self> {
        if !state_dir.is_absolute() {
            bail!("ValKhana state directory must be absolute");
        }
        Ok(Self {
            policy_dir: state_dir.join("policy"),
        })
    }

    pub fn load_automation(&self) -> Result<AutomationStateDocument> {
        let path = self.automation_path();
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(AutomationStateDocument::default());
            }
            Err(error) => {
                return Err(error).with_context(|| format!("failed to read {}", path.display()));
            }
        };
        let document: AutomationStateDocument = serde_json::from_slice(&bytes)
            .with_context(|| format!("failed to parse {}", path.display()))?;
        if document.schema_version != STATE_SCHEMA_VERSION {
            bail!(
                "unsupported state schema_version {} in {}; expected {}",
                document.schema_version,
                path.display(),
                STATE_SCHEMA_VERSION
            );
        }
        Ok(document)
    }

    pub fn set_automation(&self, state: AutomationState) -> Result<AutomationStateDocument> {
        fs::create_dir_all(&self.policy_dir)
            .with_context(|| format!("failed to create {}", self.policy_dir.display()))?;
        fs::set_permissions(&self.policy_dir, fs::Permissions::from_mode(0o700))?;
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .mode(0o600)
            .open(self.policy_dir.join("automation.lock"))?;
        lock.set_permissions(fs::Permissions::from_mode(0o600))?;
        lock.lock_exclusive()?;
        let document = AutomationStateDocument {
            schema_version: STATE_SCHEMA_VERSION,
            state,
        };
        self.write_automation(&document)?;
        FileExt::unlock(&lock)?;
        Ok(document)
    }

    fn write_automation(&self, document: &AutomationStateDocument) -> Result<()> {
        let target = self.automation_path();
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
        let temporary = self.policy_dir.join(format!(
            ".automation.json.{}.{}.tmp",
            std::process::id(),
            nonce
        ));
        let bytes = serde_json::to_vec_pretty(document)?;
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&temporary)?;
        file.write_all(&bytes)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        fs::rename(&temporary, &target)?;
        File::open(&self.policy_dir)?.sync_all()?;
        Ok(())
    }

    fn automation_path(&self) -> PathBuf {
        self.policy_dir.join("automation.json")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn temporary_state_dir(test: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "valkhana-state-{test}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn missing_state_fails_closed_to_stopped() {
        let root = temporary_state_dir("default");
        let store = StateStore::new(&root).unwrap();
        assert_eq!(
            store.load_automation().unwrap().state,
            AutomationState::Stopped
        );
    }

    #[test]
    fn persists_versioned_automation_state_atomically() {
        let root = temporary_state_dir("persist");
        let store = StateStore::new(&root).unwrap();
        store.set_automation(AutomationState::Paused).unwrap();
        assert_eq!(
            store.load_automation().unwrap().state,
            AutomationState::Paused
        );
        assert_eq!(
            fs::metadata(root.join("policy"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(root.join("policy/automation.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_unknown_schema_versions() {
        let root = temporary_state_dir("schema");
        fs::create_dir_all(root.join("policy")).unwrap();
        fs::write(
            root.join("policy/automation.json"),
            r#"{"schema_version":2,"state":"STOPPED"}"#,
        )
        .unwrap();
        let error = StateStore::new(&root)
            .unwrap()
            .load_automation()
            .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("unsupported state schema_version 2")
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_relative_state_roots() {
        assert!(StateStore::new(Path::new("relative")).is_err());
    }
}
