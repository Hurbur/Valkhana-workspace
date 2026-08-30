use std::{
    collections::BTreeMap,
    env,
    ffi::OsString,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

pub const CONFIG_SCHEMA_VERSION: u32 = 1;
const CONFIG_SIZE_LIMIT: u64 = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct XdgDirectories {
    pub config_dir: PathBuf,
    pub state_dir: PathBuf,
    pub cache_dir: PathBuf,
    pub data_dir: PathBuf,
    pub runtime_dir: PathBuf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum ConfigKind {
    Main,
    Models,
    Routing,
    Permissions,
    Services,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct VersionedConfig {
    pub schema_version: u32,
    #[serde(flatten)]
    pub values: BTreeMap<String, yaml_serde::Value>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ConfigSet {
    documents: BTreeMap<ConfigKind, VersionedConfig>,
    project: Option<ProjectMapping>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct ProjectMapping {
    pub id: String,
    pub hermes_board: String,
    pub repo: PathBuf,
    pub default_workspace: ProjectWorkspace,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ProjectWorkspace {
    Worktree,
    Scratch,
}

#[derive(Debug, Clone, Default)]
pub struct XdgEnvironment {
    pub home: Option<OsString>,
    pub config_home: Option<OsString>,
    pub state_home: Option<OsString>,
    pub cache_home: Option<OsString>,
    pub data_home: Option<OsString>,
    pub runtime_dir: Option<OsString>,
}

impl ConfigKind {
    pub const ALL: [Self; 5] = [
        Self::Main,
        Self::Models,
        Self::Routing,
        Self::Permissions,
        Self::Services,
    ];

    pub const fn filename(self) -> &'static str {
        match self {
            Self::Main => "valkhana.yaml",
            Self::Models => "models.yaml",
            Self::Routing => "routing.yaml",
            Self::Permissions => "permissions.yaml",
            Self::Services => "services.yaml",
        }
    }
}

impl XdgEnvironment {
    pub fn current() -> Self {
        Self {
            home: env::var_os("HOME"),
            config_home: env::var_os("XDG_CONFIG_HOME"),
            state_home: env::var_os("XDG_STATE_HOME"),
            cache_home: env::var_os("XDG_CACHE_HOME"),
            data_home: env::var_os("XDG_DATA_HOME"),
            runtime_dir: env::var_os("XDG_RUNTIME_DIR"),
        }
    }
}

impl XdgDirectories {
    pub fn from_env() -> Result<Self> {
        Self::from_environment(XdgEnvironment::current())
    }

    pub fn from_environment(environment: XdgEnvironment) -> Result<Self> {
        let home = required_absolute(environment.home, "HOME")?;
        let runtime_root = required_absolute(environment.runtime_dir, "XDG_RUNTIME_DIR")?;
        Ok(Self {
            config_dir: xdg_root(environment.config_home, &home, ".config", "XDG_CONFIG_HOME")?
                .join("valkhana"),
            state_dir: xdg_root(
                environment.state_home,
                &home,
                ".local/state",
                "XDG_STATE_HOME",
            )?
            .join("valkhana"),
            cache_dir: xdg_root(environment.cache_home, &home, ".cache", "XDG_CACHE_HOME")?
                .join("valkhana"),
            data_dir: xdg_root(
                environment.data_home,
                &home,
                ".local/share",
                "XDG_DATA_HOME",
            )?
            .join("valkhana"),
            runtime_dir: runtime_root.join("valkhana"),
        })
    }
}

impl ConfigSet {
    pub fn load(config_dir: &Path) -> Result<Self> {
        if !config_dir.is_absolute() {
            bail!("ValKhana configuration directory must be absolute");
        }
        let mut documents = BTreeMap::new();
        for kind in ConfigKind::ALL {
            let path = config_dir.join(kind.filename());
            let metadata = match std::fs::metadata(&path) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => {
                    return Err(error)
                        .with_context(|| format!("failed to inspect {}", path.display()));
                }
            };
            if !metadata.is_file() {
                bail!(
                    "configuration path is not a regular file: {}",
                    path.display()
                );
            }
            if metadata.len() > CONFIG_SIZE_LIMIT {
                bail!(
                    "configuration file exceeds {CONFIG_SIZE_LIMIT} bytes: {}",
                    path.display()
                );
            }
            let bytes = std::fs::read(&path)
                .with_context(|| format!("failed to read {}", path.display()))?;
            if bytes.len() as u64 > CONFIG_SIZE_LIMIT {
                bail!(
                    "configuration file exceeds {CONFIG_SIZE_LIMIT} bytes: {}",
                    path.display()
                );
            }
            let document: VersionedConfig = yaml_serde::from_slice(&bytes)
                .with_context(|| format!("failed to parse {}", path.display()))?;
            if document.schema_version != CONFIG_SCHEMA_VERSION {
                bail!(
                    "unsupported schema_version {} in {}; expected {}",
                    document.schema_version,
                    path.display(),
                    CONFIG_SCHEMA_VERSION
                );
            }
            documents.insert(kind, document);
        }
        let project = documents
            .get(&ConfigKind::Main)
            .and_then(|document| document.values.get("project"))
            .cloned()
            .map(yaml_serde::from_value::<ProjectMapping>)
            .transpose()
            .context("invalid project mapping in valkhana.yaml")?;
        if let Some(project) = &project {
            validate_project_mapping(project)?;
        }
        Ok(Self { documents, project })
    }

    pub fn get(&self, kind: ConfigKind) -> Option<&VersionedConfig> {
        self.documents.get(&kind)
    }

    pub fn iter(&self) -> impl Iterator<Item = (ConfigKind, &VersionedConfig)> {
        self.documents.iter().map(|(kind, value)| (*kind, value))
    }

    pub fn len(&self) -> usize {
        self.documents.len()
    }

    pub fn is_empty(&self) -> bool {
        self.documents.is_empty()
    }

    pub fn project(&self) -> Option<&ProjectMapping> {
        self.project.as_ref()
    }
}

fn validate_project_mapping(project: &ProjectMapping) -> Result<()> {
    for (name, value) in [
        ("project.id", project.id.as_str()),
        ("project.hermes_board", project.hermes_board.as_str()),
    ] {
        if value.is_empty()
            || value.len() > 128
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        {
            bail!("{name} must be a 1-128 character slug");
        }
    }
    if !project.repo.is_absolute() {
        bail!("project.repo must be an absolute path");
    }
    Ok(())
}

fn required_absolute(value: Option<OsString>, name: &str) -> Result<PathBuf> {
    let path = value
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .with_context(|| format!("{name} is required"))?;
    if !path.is_absolute() {
        bail!("{name} must be an absolute path");
    }
    Ok(path)
}

fn xdg_root(value: Option<OsString>, home: &Path, fallback: &str, name: &str) -> Result<PathBuf> {
    match value.filter(|value| !value.is_empty()) {
        Some(value) => required_absolute(Some(value), name),
        None => Ok(home.join(fallback)),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeConfig {
    pub runtime_dir: PathBuf,
    pub socket_path: PathBuf,
    pub lock_path: PathBuf,
}

impl RuntimeConfig {
    pub fn from_env() -> Result<Self> {
        Self::from_xdg_runtime_dir(env::var_os("XDG_RUNTIME_DIR"))
    }

    pub fn from_xdg_runtime_dir(value: Option<OsString>) -> Result<Self> {
        let xdg_runtime_dir = value
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .context(
                "XDG_RUNTIME_DIR is required; refusing to place runtime files in persistent storage",
            )?;

        if !xdg_runtime_dir.is_absolute() {
            bail!("XDG_RUNTIME_DIR must be an absolute path");
        }

        let runtime_dir = xdg_runtime_dir.join("valkhana");
        let socket_path = runtime_dir.join("core.sock");
        let lock_path = runtime_dir.join("core.lock");
        Ok(Self {
            runtime_dir,
            socket_path,
            lock_path,
        })
    }

    pub fn from_directories(directories: &XdgDirectories) -> Self {
        let runtime_dir = directories.runtime_dir.clone();
        Self {
            socket_path: runtime_dir.join("core.sock"),
            lock_path: runtime_dir.join("core.lock"),
            runtime_dir,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn derives_canonical_runtime_paths() {
        let config = RuntimeConfig::from_xdg_runtime_dir(Some("/run/user/1000".into())).unwrap();
        assert_eq!(config.runtime_dir, Path::new("/run/user/1000/valkhana"));
        assert_eq!(
            config.socket_path,
            Path::new("/run/user/1000/valkhana/core.sock")
        );
        assert_eq!(
            config.lock_path,
            Path::new("/run/user/1000/valkhana/core.lock")
        );
    }

    #[test]
    fn rejects_missing_empty_and_relative_runtime_directories() {
        assert!(RuntimeConfig::from_xdg_runtime_dir(None).is_err());
        assert!(RuntimeConfig::from_xdg_runtime_dir(Some(OsString::new())).is_err());
        assert!(RuntimeConfig::from_xdg_runtime_dir(Some("relative/path".into())).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn accepts_non_utf8_absolute_runtime_directory() {
        use std::os::unix::ffi::OsStringExt;

        let value = OsString::from_vec(b"/run/user/non-utf8-\xff".to_vec());
        let config = RuntimeConfig::from_xdg_runtime_dir(Some(value)).unwrap();
        assert!(config.socket_path.ends_with("valkhana/core.sock"));
    }

    fn environment() -> XdgEnvironment {
        XdgEnvironment {
            home: Some("/home/tester".into()),
            runtime_dir: Some("/run/user/1000".into()),
            ..XdgEnvironment::default()
        }
    }

    #[test]
    fn derives_all_canonical_xdg_fallbacks() {
        let directories = XdgDirectories::from_environment(environment()).unwrap();
        assert_eq!(
            directories.config_dir,
            Path::new("/home/tester/.config/valkhana")
        );
        assert_eq!(
            directories.state_dir,
            Path::new("/home/tester/.local/state/valkhana")
        );
        assert_eq!(
            directories.cache_dir,
            Path::new("/home/tester/.cache/valkhana")
        );
        assert_eq!(
            directories.data_dir,
            Path::new("/home/tester/.local/share/valkhana")
        );
        assert_eq!(
            directories.runtime_dir,
            Path::new("/run/user/1000/valkhana")
        );
    }

    #[test]
    fn honors_absolute_xdg_roots_and_rejects_relative_values() {
        let directories = XdgDirectories::from_environment(XdgEnvironment {
            config_home: Some("/xdg/config".into()),
            state_home: Some("/xdg/state".into()),
            cache_home: Some("/xdg/cache".into()),
            data_home: Some("/xdg/data".into()),
            ..environment()
        })
        .unwrap();
        assert_eq!(directories.config_dir, Path::new("/xdg/config/valkhana"));
        assert_eq!(directories.state_dir, Path::new("/xdg/state/valkhana"));
        assert_eq!(directories.cache_dir, Path::new("/xdg/cache/valkhana"));
        assert_eq!(directories.data_dir, Path::new("/xdg/data/valkhana"));

        let mut invalid = environment();
        invalid.config_home = Some("relative".into());
        assert!(XdgDirectories::from_environment(invalid).is_err());
    }

    #[test]
    fn requires_absolute_home_and_runtime_roots() {
        let mut missing_home = environment();
        missing_home.home = None;
        assert!(XdgDirectories::from_environment(missing_home).is_err());

        let mut missing_runtime = environment();
        missing_runtime.runtime_dir = None;
        assert!(XdgDirectories::from_environment(missing_runtime).is_err());

        let mut relative_home = environment();
        relative_home.home = Some("relative".into());
        assert!(XdgDirectories::from_environment(relative_home).is_err());
    }

    #[test]
    fn loads_only_canonical_versioned_yaml_documents() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(
            directory.path().join("valkhana.yaml"),
            "schema_version: 1\ncore:\n  log_filter: info\n",
        )
        .unwrap();
        std::fs::write(
            directory.path().join("models.yaml"),
            "schema_version: 1\nmodels: {}\n",
        )
        .unwrap();
        std::fs::write(
            directory.path().join("ignored.yaml"),
            "schema_version: 99\n",
        )
        .unwrap();

        let configs = ConfigSet::load(directory.path()).unwrap();
        assert_eq!(configs.iter().count(), 2);
        assert_eq!(
            configs.get(ConfigKind::Main).unwrap().schema_version,
            CONFIG_SCHEMA_VERSION
        );
        assert!(configs.get(ConfigKind::Permissions).is_none());
    }

    #[test]
    fn rejects_missing_or_unsupported_schema_versions() {
        for content in [
            "core: {}\n",
            "schema_version: 2\ncore: {}\n",
            "- schema_version\n- 1\n",
        ] {
            let directory = tempfile::tempdir().unwrap();
            std::fs::write(directory.path().join("valkhana.yaml"), content).unwrap();
            assert!(ConfigSet::load(directory.path()).is_err(), "{content}");
        }
    }

    #[test]
    fn rejects_relative_config_directories_and_non_files() {
        assert!(ConfigSet::load(Path::new("relative/config")).is_err());
        let directory = tempfile::tempdir().unwrap();
        std::fs::create_dir(directory.path().join("valkhana.yaml")).unwrap();
        assert!(ConfigSet::load(directory.path()).is_err());
    }

    #[test]
    fn loads_the_documented_project_to_board_mapping() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(
            directory.path().join("valkhana.yaml"),
            "schema_version: 1\nproject:\n  id: corpse-war\n  hermes_board: corpse-war\n  repo: /projects/corpse-war\n  default_workspace: worktree\n",
        )
        .unwrap();

        let configs = ConfigSet::load(directory.path()).unwrap();
        let project = configs.project().unwrap();
        assert_eq!(project.id, "corpse-war");
        assert_eq!(project.hermes_board, "corpse-war");
        assert_eq!(project.repo, Path::new("/projects/corpse-war"));
        assert_eq!(project.default_workspace, ProjectWorkspace::Worktree);
    }

    #[test]
    fn rejects_unsafe_project_mappings_before_readiness() {
        for project in [
            "id: ../unsafe\n  hermes_board: safe\n  repo: /project\n  default_workspace: worktree",
            "id: safe\n  hermes_board: ../unsafe\n  repo: /project\n  default_workspace: worktree",
            "id: safe\n  hermes_board: safe\n  repo: relative\n  default_workspace: worktree",
        ] {
            let directory = tempfile::tempdir().unwrap();
            std::fs::write(
                directory.path().join("valkhana.yaml"),
                format!("schema_version: 1\nproject:\n  {project}\n"),
            )
            .unwrap();
            assert!(ConfigSet::load(directory.path()).is_err(), "{project}");
        }
    }
}
