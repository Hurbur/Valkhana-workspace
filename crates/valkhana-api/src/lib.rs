use std::{path::Path, time::Duration};

use anyhow::{Context, Result, bail};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::UnixStream,
    time::timeout,
};
use valkhana_domain::{HealthResponse, HealthStatus, SERVICE_NAME};

const REQUEST: &[u8] = b"GET /v1/health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n";
const RESPONSE_LIMIT: usize = 64 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(2);

pub async fn fetch_core_health(socket_path: &Path) -> Result<HealthResponse> {
    timeout(REQUEST_TIMEOUT, fetch_core_health_inner(socket_path))
        .await
        .context("ValKhana core health request timed out")?
}

async fn fetch_core_health_inner(socket_path: &Path) -> Result<HealthResponse> {
    let mut stream = UnixStream::connect(socket_path)
        .await
        .with_context(|| format!("failed to connect to {}", socket_path.display()))?;
    stream.write_all(REQUEST).await?;

    let mut response = Vec::with_capacity(1024);
    let mut chunk = [0_u8; 1024];
    loop {
        let read = stream.read(&mut chunk).await?;
        if read == 0 {
            break;
        }
        if response.len() + read > RESPONSE_LIMIT {
            bail!("ValKhana core health response exceeded {RESPONSE_LIMIT} bytes");
        }
        response.extend_from_slice(&chunk[..read]);
    }

    let split = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .context("ValKhana core returned a malformed HTTP response")?;
    let headers = std::str::from_utf8(&response[..split])?;
    let status = headers.lines().next().unwrap_or_default();
    if !status.starts_with("HTTP/1.1 200 ") {
        bail!("ValKhana core returned unexpected status: {status}");
    }

    let health: HealthResponse = serde_json::from_slice(&response[split + 4..])
        .context("ValKhana core returned invalid health JSON")?;
    if health.name != SERVICE_NAME || health.status != HealthStatus::Healthy {
        bail!("ValKhana core returned an invalid service identity or health state");
    }
    Ok(health)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;
    use tokio::net::UnixListener;

    async fn serve_once(response: Vec<u8>) -> (TempDir, std::path::PathBuf) {
        let directory = tempfile::tempdir().expect("temporary directory");
        let socket_path = directory.path().join("core.sock");
        let listener = UnixListener::bind(&socket_path).expect("bind test socket");
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.expect("accept request");
            let mut request = vec![0_u8; REQUEST.len()];
            stream.read_exact(&mut request).await.expect("read request");
            assert_eq!(request, REQUEST);
            stream.write_all(&response).await.expect("write response");
        });
        (directory, socket_path)
    }

    fn http_response(status: &str, body: &[u8]) -> Vec<u8> {
        let mut response = format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
            body.len()
        )
        .into_bytes();
        response.extend_from_slice(body);
        response
    }

    #[tokio::test]
    async fn fetches_and_validates_core_health() {
        let body = br#"{"name":"valkhana-core","version":"0.1.0","status":"healthy"}"#;
        let (_directory, socket_path) = serve_once(http_response("200 OK", body)).await;

        let health = fetch_core_health(&socket_path).await.expect("valid health");

        assert_eq!(health.name, SERVICE_NAME);
        assert_eq!(health.version, "0.1.0");
        assert_eq!(health.status, HealthStatus::Healthy);
    }

    #[tokio::test]
    async fn rejects_non_success_status() {
        let (_directory, socket_path) =
            serve_once(http_response("503 Service Unavailable", b"{}")).await;

        let error = fetch_core_health(&socket_path).await.unwrap_err();

        assert!(error.to_string().contains("unexpected status"));
    }

    #[tokio::test]
    async fn rejects_invalid_json_and_service_identity() {
        let (_directory, socket_path) = serve_once(http_response("200 OK", b"not-json")).await;
        let error = fetch_core_health(&socket_path).await.unwrap_err();
        assert!(error.to_string().contains("invalid health JSON"));

        let body = br#"{"name":"another-service","version":"0.1.0","status":"healthy"}"#;
        let (_directory, socket_path) = serve_once(http_response("200 OK", body)).await;
        let error = fetch_core_health(&socket_path).await.unwrap_err();
        assert!(error.to_string().contains("invalid service identity"));
    }

    #[tokio::test]
    async fn rejects_oversized_responses() {
        let oversized = vec![b'x'; RESPONSE_LIMIT + 1];
        let (_directory, socket_path) = serve_once(oversized).await;

        let error = fetch_core_health(&socket_path).await.unwrap_err();

        assert!(error.to_string().contains("exceeded"));
    }
}
