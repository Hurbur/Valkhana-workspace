use std::{
    fs::{File, OpenOptions, Permissions},
    os::unix::fs::{FileTypeExt, PermissionsExt},
    path::Path,
    sync::Arc,
};

use anyhow::{Context, Result, bail};
use fs2::FileExt;
use sd_notify::NotifyState;
use tokio::{net::UnixListener, signal};
use tracing::{info, warn};
use tracing_subscriber::EnvFilter;
use valkhana_components::ComponentRegistry;
use valkhana_config::{ConfigSet, RuntimeConfig, XdgDirectories};
use valkhana_core::{PersistentNonceReplayLedger, app_with_persistent_nonce_ledger};
use valkhana_hermes::HermesAdapter;
use valkhana_policy::{PolicyConfiguration, PolicyLedger, PolicyService};
use valkhana_secrets::SecretServiceStore;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| "valkhana_core=info".into()),
        )
        .init();

    let directories = XdgDirectories::from_env()?;
    let loaded_config = ConfigSet::load(&directories.config_dir)?;
    let loaded_policy = PolicyConfiguration::from_config(&loaded_config)?;
    let component_registry = ComponentRegistry::load_from_data_dir(&directories.data_dir)?;
    let policy_service = PolicyService::new(
        loaded_policy.clone(),
        PolicyLedger::open(&directories.state_dir)?,
    );
    let nonce_replay = PersistentNonceReplayLedger::open(&directories.state_dir)?;
    info!(
        config_dir = %directories.config_dir.display(),
        documents = loaded_config.len(),
        policy_agents = loaded_policy.agent_count(),
        registered_components = component_registry.as_ref().map_or(0, ComponentRegistry::len),
        "ValKhana configuration validated"
    );
    let config = RuntimeConfig::from_directories(&directories);
    prepare_runtime_dir(&config.runtime_dir)?;
    let _instance_lock = acquire_instance_lock(&config.lock_path)?;
    remove_stale_socket(&config.socket_path)?;

    let listener = UnixListener::bind(&config.socket_path)
        .with_context(|| format!("failed to bind {}", config.socket_path.display()))?;
    std::fs::set_permissions(&config.socket_path, Permissions::from_mode(0o600))?;
    sd_notify::notify(&[
        NotifyState::Ready,
        NotifyState::Status("ValKhana core is healthy"),
    ])
    .context("failed to notify systemd that ValKhana core is ready")?;

    info!(socket = %config.socket_path.display(), "ValKhana core listening");
    let project = loaded_config.project().cloned();
    let result = axum::serve(
        listener,
        app_with_persistent_nonce_ledger(
            HermesAdapter::from_env()?,
            project,
            Some(policy_service),
            Some(Arc::new(SecretServiceStore)),
            nonce_replay,
        ),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await;

    if let Err(error) = sd_notify::notify(&[
        NotifyState::Stopping,
        NotifyState::Status("ValKhana core is stopping"),
    ]) {
        warn!(%error, "failed to notify systemd that ValKhana core is stopping");
    }

    if let Err(error) = std::fs::remove_file(&config.socket_path) {
        warn!(%error, socket = %config.socket_path.display(), "failed to remove socket during shutdown");
    }

    result.context("ValKhana core server failed")
}

fn prepare_runtime_dir(path: &Path) -> Result<()> {
    std::fs::create_dir_all(path)
        .with_context(|| format!("failed to create runtime directory {}", path.display()))?;
    std::fs::set_permissions(path, Permissions::from_mode(0o700))?;
    Ok(())
}

fn acquire_instance_lock(path: &Path) -> Result<File> {
    let file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(path)
        .with_context(|| format!("failed to open instance lock {}", path.display()))?;

    file.try_lock_exclusive()
        .with_context(|| format!("another ValKhana core instance owns {}", path.display()))?;
    Ok(file)
}

fn remove_stale_socket(path: &Path) -> Result<()> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };

    if !metadata.file_type().is_socket() {
        bail!("refusing to remove non-socket path at {}", path.display());
    }

    std::fs::remove_file(path)
        .with_context(|| format!("failed to remove stale socket {}", path.display()))
}

async fn shutdown_signal() {
    let ctrl_c = async {
        signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        signal::unix::signal(signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
    }
}
