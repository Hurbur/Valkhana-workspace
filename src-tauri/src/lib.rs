use valkhana_config::RuntimeConfig;
use valkhana_domain::HealthResponse;

#[cfg(not(debug_assertions))]
use std::{sync::Mutex, time::Duration};
#[cfg(not(debug_assertions))]
use tauri::{Manager, RunEvent};
#[cfg(not(debug_assertions))]
use tauri_plugin_shell::{ShellExt, process::CommandChild};
#[cfg(not(debug_assertions))]
use tokio::io::{AsyncReadExt, AsyncWriteExt};
#[cfg(not(debug_assertions))]
use valkhana_secrets::{SecretServiceStore, SecretValue};

#[cfg(not(debug_assertions))]
const WEB_SERVER_ADDRESS: &str = "127.0.0.1:3847";

#[cfg(not(debug_assertions))]
struct WebServer(Mutex<Option<CommandChild>>);

#[cfg(not(debug_assertions))]
fn desktop_token() -> std::io::Result<String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(|error| {
        std::io::Error::other(format!("random token generation failed: {error}"))
    })?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[cfg(not(debug_assertions))]
fn dashboard_service_token() -> anyhow::Result<Option<SecretValue>> {
    valkhana_secrets::load_current_dashboard_service_key(&SecretServiceStore).map(Some)
}

#[cfg(not(debug_assertions))]
async fn spawned_server_is_ready(token: &str) -> bool {
    let Ok(mut stream) = tokio::net::TcpStream::connect(WEB_SERVER_ADDRESS).await else {
        return false;
    };
    let request = format!(
        "GET /__valkhana_desktop_ready HTTP/1.1\r\nHost: {WEB_SERVER_ADDRESS}\r\nX-ValKhana-Desktop-Token: {token}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).await.is_err() {
        return false;
    }
    let mut response = Vec::with_capacity(256);
    if stream.read_to_end(&mut response).await.is_err() || response.len() > 4096 {
        return false;
    }
    let Ok(response) = String::from_utf8(response) else {
        return false;
    };
    response.starts_with("HTTP/1.1 200 ") && response.ends_with(token)
}

#[tauri::command]
async fn valkhana_core_health() -> Result<HealthResponse, String> {
    let config = RuntimeConfig::from_env().map_err(|error| error.to_string())?;
    valkhana_api::fetch_core_health(&config.socket_path)
        .await
        .map_err(|error| error.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            #[cfg(not(debug_assertions))]
            {
                let token = desktop_token()?;
                let service_token = match dashboard_service_token() {
                    Ok(token) => token,
                    Err(error) => {
                        log::warn!("dashboard service authentication is unavailable: {error}");
                        None
                    }
                };
                let mut command = app
                    .shell()
                    .sidecar("valkhana-web")?
                    .args(["--port", "3847"])
                    .env("NODE_ENV", "production")
                    .env("PORT", "3847")
                    .env("HOST", "127.0.0.1")
                    .env("HERMES_WORKSPACE_DESKTOP", "1")
                    .env("VALKHANA_DESKTOP_TOKEN", &token);
                if let Some(service_token) = &service_token {
                    let token_text = std::str::from_utf8(service_token.expose()).map_err(|_| {
                        std::io::Error::new(
                            std::io::ErrorKind::InvalidData,
                            "dashboard service token is not UTF-8",
                        )
                    })?;
                    command = command.env("VALKHANA_CORE_SERVICE_TOKEN", token_text);
                }
                let (mut events, child) = command.spawn()?;
                app.manage(WebServer(Mutex::new(Some(child))));

                tauri::async_runtime::spawn(async move {
                    while let Some(event) = events.recv().await {
                        match event {
                            tauri_plugin_shell::process::CommandEvent::Stdout(bytes) => {
                                log::info!("web sidecar: {}", String::from_utf8_lossy(&bytes));
                            }
                            tauri_plugin_shell::process::CommandEvent::Stderr(bytes) => {
                                log::error!("web sidecar: {}", String::from_utf8_lossy(&bytes));
                            }
                            _ => {}
                        }
                    }
                });

                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    for _ in 0..200 {
                        if spawned_server_is_ready(&token).await {
                            if let Some(window) = handle.get_webview_window("main") {
                                let url = format!("http://127.0.0.1:3847/?desktop=1&token={token}")
                                    .parse()
                                    .expect("static desktop URL must be valid");
                                if let Err(error) = window.navigate(url) {
                                    log::error!("failed to navigate to desktop server: {error}");
                                }
                            }
                            return;
                        }
                        tokio::time::sleep(Duration::from_millis(100)).await;
                    }
                    log::error!("desktop web sidecar did not become ready within 20 seconds");
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![valkhana_core_health]);

    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building Tauri application");
    app.run(|app_handle, event| {
        #[cfg(debug_assertions)]
        let _ = (app_handle, event);
        #[cfg(not(debug_assertions))]
        if matches!(event, RunEvent::Exit | RunEvent::ExitRequested { .. })
            && let Some(server) = app_handle.try_state::<WebServer>()
            && let Ok(mut child) = server.0.lock()
            && let Some(child) = child.take()
            && let Err(error) = child.kill()
        {
            log::warn!("failed to stop desktop web sidecar: {error}");
        }
    });
}
