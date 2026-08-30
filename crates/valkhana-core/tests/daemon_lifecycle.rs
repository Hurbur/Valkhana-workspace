use std::{
    io::{Read, Write},
    os::unix::{fs::PermissionsExt, net::UnixStream, process::ExitStatusExt},
    path::Path,
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use nix::sys::signal::{Signal, kill};
use nix::unistd::Pid;
use tempfile::TempDir;

struct ChildGuard(Child);

impl Drop for ChildGuard {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_none() {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}

fn spawn_core(runtime: &Path) -> ChildGuard {
    ChildGuard(
        Command::new(env!("CARGO_BIN_EXE_valkhana-core"))
            .env("XDG_RUNTIME_DIR", runtime)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    )
}

fn wait_for_socket(path: &Path) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !path.exists() {
        assert!(Instant::now() < deadline, "socket was not created in time");
        thread::sleep(Duration::from_millis(10));
    }
}

fn get_health(path: &Path) -> String {
    let mut stream = UnixStream::connect(path).unwrap();
    stream
        .write_all(b"GET /v1/health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
        .unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    response
}

#[test]
fn daemon_owns_one_private_socket_and_cleans_up_on_sigterm() {
    let runtime = TempDir::new().unwrap();
    let socket = runtime.path().join("valkhana/core.sock");
    let mut first = spawn_core(runtime.path());
    wait_for_socket(&socket);

    assert_eq!(
        std::fs::metadata(&socket).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let health = get_health(&socket);
    assert!(health.starts_with("HTTP/1.1 200 OK"));
    assert!(health.contains(r#"{"name":"valkhana-core","version":"0.1.0","status":"healthy"}"#));

    let mut second = spawn_core(runtime.path());
    let second_status = second.0.wait().unwrap();
    assert!(!second_status.success(), "a second core instance must fail");
    assert!(second_status.signal().is_none());
    assert!(first.0.try_wait().unwrap().is_none());
    assert!(get_health(&socket).starts_with("HTTP/1.1 200 OK"));

    kill(Pid::from_raw(first.0.id() as i32), Signal::SIGTERM).unwrap();
    assert!(first.0.wait().unwrap().success());
    assert!(!socket.exists(), "graceful shutdown must remove core.sock");
}
