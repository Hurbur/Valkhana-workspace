#[cfg(not(unix))]
compile_error!("valkhana-electron-ssr-launcher currently supports Unix desktop builds only");

#[cfg(unix)]
mod unix {
    use std::env;
    use std::os::unix::process::CommandExt;
    use std::path::{Path, PathBuf};
    use std::process::{Command, ExitCode};

    use anyhow::{Context, Result, bail};
    use valkhana_secrets::{SecretServiceStore, load_current_dashboard_service_key};

    pub fn main() -> ExitCode {
        match run(env::args_os().skip(1).collect()) {
            Ok(never) => match never {},
            Err(error) => {
                eprintln!("ValKhana Electron SSR authentication is unavailable: {error:#}");
                ExitCode::FAILURE
            }
        }
    }

    fn run(args: Vec<std::ffi::OsString>) -> Result<std::convert::Infallible> {
        if args.len() < 2 {
            bail!("expected an Electron runtime and packaged prod-server.cjs path");
        }
        let runtime = canonical_file(Path::new(&args[0]), "Electron runtime")?;
        let server = canonical_file(Path::new(&args[1]), "SSR entrypoint")?;
        if server.file_name().and_then(|name| name.to_str()) != Some("prod-server.cjs") {
            bail!("SSR entrypoint must be the packaged prod-server.cjs");
        }

        let token = load_dashboard_token().map_err(|_| {
            eprintln!(
                "ValKhana Electron SSR service authentication is unavailable; protected actions will fail closed"
            );
        });
        let mut command = Command::new(runtime);
        command
            .arg(server)
            .args(&args[2..])
            .env("ELECTRON_RUN_AS_NODE", "1")
            .env_remove("VALKHANA_CORE_SERVICE_TOKEN");
        if let Ok(Some(token)) = token.as_ref() {
            if let Ok(token) = std::str::from_utf8(token.expose()) {
                command.env("VALKHANA_CORE_SERVICE_TOKEN", token);
            } else {
                eprintln!(
                    "ValKhana Electron SSR service authentication is unavailable; protected actions will fail closed"
                );
            }
        }

        let error = command.exec();
        Err(error).context("replace launcher with Electron SSR process")
    }

    fn load_dashboard_token() -> Result<Option<valkhana_secrets::SecretValue>> {
        load_current_dashboard_service_key(&SecretServiceStore).map(Some)
    }

    fn canonical_file(path: &Path, label: &str) -> Result<PathBuf> {
        if !path.is_absolute() {
            bail!("{label} path must be absolute");
        }
        let canonical = path
            .canonicalize()
            .with_context(|| format!("resolve {label} path"))?;
        if !canonical.is_file() {
            bail!("{label} path must name a file");
        }
        Ok(canonical)
    }
}

#[cfg(unix)]
fn main() -> std::process::ExitCode {
    unix::main()
}
