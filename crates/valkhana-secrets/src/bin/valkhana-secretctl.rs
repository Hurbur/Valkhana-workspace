use std::{
    io::{Read, Write},
    os::unix::net::UnixStream,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result, anyhow, bail};
use sha2::{Digest, Sha256};
use valkhana_secrets::{
    SecretId, SecretServiceStore, SecretStore, SecretValue, ServiceRequest,
    finalize_dashboard_key_rotation, load_current_dashboard_service_key,
    load_dashboard_service_keys, provision_dashboard_service_key, revoke_dashboard_service_key,
    rotate_dashboard_service_key, sign_service_request,
};
use zeroize::Zeroize;

fn main() -> Result<()> {
    let mut arguments = std::env::args();
    let _program = arguments.next();
    let command = arguments.next().unwrap_or_else(|| "help".to_owned());
    if arguments.next().is_some() {
        bail!("valkhana-secretctl accepts exactly one command");
    }

    let store = SecretServiceStore;
    match command.as_str() {
        "probe" => {
            store.probe()?;
            println!("ValKhana SecretStore is available and unlocked");
        }
        "list" => {
            for metadata in store.list_metadata()? {
                println!("{}\t{:?}", metadata.id.as_str(), metadata.class);
            }
        }
        "provision-dashboard" => provision_dashboard(&store)?,
        "rotate-dashboard" => rotate_dashboard(&store)?,
        "finalize-dashboard-rotation" => finalize_dashboard_rotation(&store)?,
        "revoke-dashboard" => revoke_dashboard(&store)?,
        "verify-core-auth" => verify_core_auth(&store)?,
        "verify-core-auth-previous" => verify_core_auth_previous(&store)?,
        "help" | "--help" | "-h" => {
            println!(
                "usage: valkhana-secretctl <probe|list|provision-dashboard|rotate-dashboard|finalize-dashboard-rotation|revoke-dashboard|verify-core-auth|verify-core-auth-previous>"
            );
        }
        _ => bail!("unknown valkhana-secretctl command"),
    }
    Ok(())
}

fn verify_core_auth(store: &dyn SecretStore) -> Result<()> {
    let key = load_current_dashboard_service_key(store)?;
    send_core_auth_probe(&key, "current")
}

fn verify_core_auth_previous(store: &dyn SecretStore) -> Result<()> {
    let keys = load_dashboard_service_keys(store, unix_time_ms()?)?;
    let key = keys
        .get(1)
        .context("no unexpired previous dashboard service key is available")?;
    send_core_auth_probe(key, "previous")
}

fn send_core_auth_probe(key: &SecretValue, key_name: &str) -> Result<()> {
    let service_id = SecretId::parse("service:valkhana-dashboard")?;
    let timestamp = unix_time_ms()?;
    let mut nonce_bytes = [0_u8; 16];
    getrandom::fill(&mut nonce_bytes)
        .map_err(|error| anyhow!("generate service request nonce: {error}"))?;
    let nonce = hex::encode(nonce_bytes);
    nonce_bytes.zeroize();
    let request = ServiceRequest {
        service_id: &service_id,
        method: "POST",
        path: "/v1/auth/service/probe",
        action: "probe",
        payload_sha256: Sha256::digest(b"").into(),
        timestamp_unix_ms: timestamp,
        nonce: &nonce,
    };
    let signature = sign_service_request(key.expose(), &request)?;
    let socket = core_socket_path()?;
    let mut stream =
        UnixStream::connect(&socket).with_context(|| format!("connect to {}", socket.display()))?;
    stream.write_all(
        format!(
            "POST /v1/auth/service/probe HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\nX-ValKhana-Service-Id: {}\r\nX-ValKhana-Timestamp: {timestamp}\r\nX-ValKhana-Nonce: {nonce}\r\nX-ValKhana-Signature: {signature}\r\nConnection: close\r\n\r\n",
            service_id.as_str(),
        )
        .as_bytes(),
    )?;
    let mut response = Vec::new();
    stream
        .take(64 * 1024 + 1)
        .read_to_end(&mut response)
        .context("read Core authentication probe response")?;
    if response.len() > 64 * 1024 {
        bail!("Core authentication probe response exceeded 65536 bytes");
    }
    let response = std::str::from_utf8(&response).context("Core returned non-UTF-8 HTTP")?;
    if !response.starts_with("HTTP/1.1 200 ") {
        bail!("Core rejected the dashboard service authentication probe");
    }
    println!("ValKhana Core accepted the signed dashboard service probe using the {key_name} key");
    Ok(())
}

fn core_socket_path() -> Result<PathBuf> {
    if let Some(configured) = std::env::var_os("VALKHANA_CORE_SOCKET") {
        let path = PathBuf::from(configured);
        if path.is_absolute() {
            return Ok(path);
        }
        bail!("VALKHANA_CORE_SOCKET must be absolute");
    }
    let runtime = std::env::var_os("XDG_RUNTIME_DIR").context("XDG_RUNTIME_DIR is required")?;
    let runtime = PathBuf::from(runtime);
    if !runtime.is_absolute() {
        bail!("XDG_RUNTIME_DIR must be absolute");
    }
    Ok(runtime.join("valkhana/core.sock"))
}

fn provision_dashboard(store: &dyn SecretStore) -> Result<()> {
    provision_dashboard_service_key(store, generate_dashboard_key()?)?;
    println!("Provisioned ValKhana dashboard service key in Secret Service");
    Ok(())
}

fn rotate_dashboard(store: &dyn SecretStore) -> Result<()> {
    let expires_at =
        rotate_dashboard_service_key(store, generate_dashboard_key()?, unix_time_ms()?)?;
    println!(
        "Rotated ValKhana dashboard service key; previous key expires at Unix millisecond {expires_at}"
    );
    Ok(())
}

fn finalize_dashboard_rotation(store: &dyn SecretStore) -> Result<()> {
    if finalize_dashboard_key_rotation(store)? {
        println!("Finalized ValKhana dashboard key rotation and revoked the previous key");
    } else {
        println!("No previous ValKhana dashboard key was present");
    }
    Ok(())
}

fn revoke_dashboard(store: &dyn SecretStore) -> Result<()> {
    revoke_dashboard_service_key(store)?;
    println!("Revoked ValKhana dashboard service authentication");
    Ok(())
}

fn generate_dashboard_key() -> Result<SecretValue> {
    let mut random = [0_u8; 32];
    getrandom::fill(&mut random)
        .map_err(|error| anyhow!("generate dashboard service key: {error}"))?;
    let encoded = hex::encode(random);
    random.zeroize();
    SecretValue::new(encoded.into_bytes())
}

fn unix_time_ms() -> Result<u64> {
    Ok(u64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .context("system clock is before the Unix epoch")?
            .as_millis(),
    )?)
}
