//! Bounded trusted-component registry for executable supply-chain inputs.

use std::{collections::BTreeMap, fs, path::Path};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

pub const REGISTRY_SCHEMA_VERSION: u32 = 1;
pub const MAX_REGISTRY_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ComponentType {
    Model,
    HermesPlugin,
    Mcp,
    CodexSkill,
    CodexPlugin,
    ClaudeHook,
    ClaudePlugin,
    ExternalAdapter,
    ContainerImage,
    HelperBinary,
    RuntimeExtension,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ComponentTrust {
    Candidate,
    Approved,
    Deprecated,
    Blocked,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ComponentEntry {
    #[serde(rename = "type")]
    pub component_type: ComponentType,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub revision: Option<String>,
    #[serde(default)]
    pub sha256: Option<String>,
    #[serde(default)]
    pub license: Option<String>,
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(default)]
    pub trust: Option<ComponentTrust>,
    #[serde(default)]
    pub model_ref: Option<String>,
    #[serde(default)]
    pub reviewed_at: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ComponentRegistry {
    pub schema_version: u32,
    pub components: BTreeMap<String, ComponentEntry>,
}

impl ComponentRegistry {
    pub fn load_from_data_dir(data_dir: &Path) -> Result<Option<Self>> {
        if !data_dir.is_absolute() {
            bail!("ValKhana data directory must be absolute");
        }
        let path = data_dir.join("components/registry.yaml");
        match fs::metadata(&path) {
            Ok(_) => Self::load(&path).map(Some),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => {
                Err(error).with_context(|| format!("failed to inspect {}", path.display()))
            }
        }
    }

    pub fn load(path: &Path) -> Result<Self> {
        if !path.is_absolute() {
            bail!("component registry path must be absolute");
        }
        let metadata =
            fs::metadata(path).with_context(|| format!("failed to inspect {}", path.display()))?;
        if !metadata.is_file() {
            bail!(
                "component registry is not a regular file: {}",
                path.display()
            );
        }
        if metadata.len() > MAX_REGISTRY_BYTES {
            bail!("component registry exceeds {MAX_REGISTRY_BYTES} bytes");
        }
        let bytes = fs::read(path).with_context(|| format!("failed to read {}", path.display()))?;
        let registry: Self = yaml_serde::from_slice(&bytes)
            .with_context(|| format!("failed to parse {}", path.display()))?;
        registry.validate()?;
        Ok(registry)
    }

    pub fn validate(&self) -> Result<()> {
        if self.schema_version != REGISTRY_SCHEMA_VERSION {
            bail!(
                "unsupported component registry schema_version {}; expected {}",
                self.schema_version,
                REGISTRY_SCHEMA_VERSION
            );
        }
        for (name, entry) in &self.components {
            validate_name(name)?;
            validate_entry(name, entry)?;
        }
        Ok(())
    }

    pub fn autonomous_component(&self, name: &str) -> Result<&ComponentEntry> {
        let entry = self
            .components
            .get(name)
            .with_context(|| format!("component {name:?} is not registered"))?;
        if entry.component_type == ComponentType::Model {
            bail!("model trust is resolved through models.yaml, not the component registry");
        }
        if entry.trust != Some(ComponentTrust::Approved) {
            bail!("component {name:?} is not approved for autonomous use");
        }
        Ok(entry)
    }

    pub fn len(&self) -> usize {
        self.components.len()
    }

    pub fn is_empty(&self) -> bool {
        self.components.is_empty()
    }
}

fn validate_name(name: &str) -> Result<()> {
    if name.is_empty()
        || name.len() > 128
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        bail!("invalid component name {name:?}");
    }
    Ok(())
}

fn validate_entry(name: &str, entry: &ComponentEntry) -> Result<()> {
    for permission in &entry.permissions {
        if permission.trim().is_empty() || permission.len() > 200 {
            bail!("component {name:?} has an invalid permission");
        }
    }
    if let Some(hash) = &entry.sha256
        && (hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()))
    {
        bail!("component {name:?} has an invalid sha256");
    }
    if entry.component_type == ComponentType::Model {
        if entry.trust.is_some() {
            bail!("model component {name:?} must not duplicate trust from models.yaml");
        }
        if entry.model_ref.as_deref().is_none_or(str::is_empty) {
            bail!("model component {name:?} requires model_ref");
        }
    } else {
        if entry.model_ref.is_some() {
            bail!("non-model component {name:?} must not set model_ref");
        }
        if entry.trust.is_none() {
            bail!("non-model component {name:?} requires a trust state");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn registry(yaml: &str) -> Result<ComponentRegistry> {
        let mut file = tempfile::NamedTempFile::new()?;
        file.write_all(yaml.as_bytes())?;
        ComponentRegistry::load(file.path())
    }

    #[test]
    fn approved_pinned_component_can_be_selected() {
        let registry = registry(
            "schema_version: 1\ncomponents:\n  blender-mcp:\n    type: mcp\n    revision: abc123\n    sha256: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n    trust: approved\n    permissions: [blender-control]\n",
        )
        .unwrap();
        assert_eq!(
            registry.autonomous_component("blender-mcp").unwrap().trust,
            Some(ComponentTrust::Approved)
        );
    }

    #[test]
    fn unregistered_candidate_and_blocked_components_fail_closed() {
        let registry = registry(
            "schema_version: 1\ncomponents:\n  candidate-tool:\n    type: helper_binary\n    trust: candidate\n  blocked-tool:\n    type: helper_binary\n    trust: blocked\n",
        )
        .unwrap();
        assert!(registry.autonomous_component("missing").is_err());
        assert!(registry.autonomous_component("candidate-tool").is_err());
        assert!(registry.autonomous_component("blocked-tool").is_err());
    }

    #[test]
    fn model_references_cannot_duplicate_model_trust() {
        let error = registry(
            "schema_version: 1\ncomponents:\n  qwen38:\n    type: model\n    model_ref: qwen38\n    trust: approved\n",
        )
        .unwrap_err();
        assert!(error.to_string().contains("must not duplicate trust"));
    }

    #[test]
    fn model_reference_without_registry_trust_is_valid_but_not_executable() {
        let registry = registry(
            "schema_version: 1\ncomponents:\n  qwen38:\n    type: model\n    model_ref: qwen38\n",
        )
        .unwrap();
        assert!(registry.autonomous_component("qwen38").is_err());
    }

    #[test]
    fn canonical_data_path_is_optional_but_relative_roots_are_rejected() {
        let root = tempfile::tempdir().unwrap();
        assert!(
            ComponentRegistry::load_from_data_dir(root.path())
                .unwrap()
                .is_none()
        );
        assert!(ComponentRegistry::load_from_data_dir(Path::new("relative")).is_err());
    }
}
