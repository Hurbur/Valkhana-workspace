use std::{
    collections::BTreeMap,
    net::IpAddr,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use anyhow::{Context, Result, bail};
use semver::Version;
use serde::{Deserialize, Serialize};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    time::{sleep, timeout},
};
use url::{Host, Url};

const DEFAULT_GATEWAY_URL: &str = "http://127.0.0.1:8642";
const RESPONSE_LIMIT: usize = 64 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(2);
const CLI_TIMEOUT: Duration = Duration::from_secs(5);
pub const MINIMUM_HERMES_VERSION: &str = "0.20.2";

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HermesGatewayEndpoint {
    host: String,
    port: u16,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct HermesGatewayHealth {
    pub endpoint: String,
    pub payload: serde_json::Value,
    pub compatible: bool,
    pub compatibility_reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct HermesBoard {
    pub slug: String,
    pub name: String,
    #[serde(default)]
    pub archived: bool,
    #[serde(default)]
    pub is_current: bool,
    #[serde(default)]
    pub counts: BTreeMap<String, u64>,
    #[serde(default)]
    pub total: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct HermesTask {
    pub id: String,
    pub title: String,
    pub body: Option<String>,
    pub assignee: Option<String>,
    pub status: HermesTaskStatus,
    pub priority: i64,
    pub created_by: String,
    pub created_at: i64,
    pub started_at: Option<i64>,
    pub completed_at: Option<i64>,
    pub result: Option<String>,
    #[serde(default)]
    pub skills: Vec<String>,
    pub max_retries: Option<u64>,
    pub model_override: Option<String>,
    pub provider_override: Option<String>,
    pub session_id: Option<String>,
    pub workspace_kind: String,
    pub workspace_path: Option<String>,
    pub branch_name: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CreateTaskRequest {
    pub title: String,
    pub body: Option<String>,
    pub idempotency_key: String,
    pub workspace: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TaskMutation {
    Assign {
        profile: Option<String>,
    },
    LinkDependency {
        child_task_id: String,
    },
    UnlinkDependency {
        child_task_id: String,
    },
    Promote {
        reason: String,
    },
    Reclaim {
        reason: String,
    },
    Reassign {
        profile: Option<String>,
        reason: String,
    },
    Block {
        reason: String,
    },
    RequestReview {
        summary: String,
    },
    RequestChanges {
        reason: String,
    },
    ReopenReview {
        reason: String,
    },
    Complete {
        result: String,
    },
    Archive,
}

#[derive(Debug, Deserialize)]
struct HermesTaskDetail {
    task: HermesTask,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum HermesTaskStatus {
    Triage,
    Todo,
    Scheduled,
    Ready,
    Running,
    Blocked,
    Review,
    Done,
    Archived,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HermesCli {
    path: PathBuf,
}

#[derive(Clone, Debug)]
pub enum HermesAdapter {
    Cli(HermesCli),
    Gateway(HermesGatewayEndpoint),
}

impl HermesGatewayEndpoint {
    pub fn from_env() -> Result<Self> {
        let value =
            std::env::var("HERMES_GATEWAY_URL").unwrap_or_else(|_| DEFAULT_GATEWAY_URL.to_owned());
        Self::parse(&value)
    }

    pub fn parse(value: &str) -> Result<Self> {
        let url = Url::parse(value).context("HERMES_GATEWAY_URL must be a valid URL")?;
        if url.scheme() != "http" {
            bail!("Hermes gateway must use loopback HTTP");
        }
        if !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.path() != "/"
        {
            bail!("Hermes gateway URL must contain only a loopback origin");
        }
        let parsed_host = url.host().context("Hermes gateway URL is missing a host")?;
        let (host, is_loopback) = match parsed_host {
            Host::Domain(host) => (host.to_owned(), host.eq_ignore_ascii_case("localhost")),
            Host::Ipv4(address) => (address.to_string(), address.is_loopback()),
            Host::Ipv6(address) => (address.to_string(), address.is_loopback()),
        };
        if !is_loopback {
            bail!("Hermes gateway must be bound to a loopback host");
        }
        Ok(Self {
            host,
            port: url.port().unwrap_or(80),
        })
    }

    pub fn origin(&self) -> String {
        if self
            .host
            .parse::<IpAddr>()
            .is_ok_and(|address| address.is_ipv6())
        {
            format!("http://[{}]:{}", self.host, self.port)
        } else {
            format!("http://{}:{}", self.host, self.port)
        }
    }

    pub async fn health(&self) -> Result<HermesGatewayHealth> {
        timeout(REQUEST_TIMEOUT, self.health_inner())
            .await
            .context("Hermes gateway health request timed out")?
    }

    async fn health_inner(&self) -> Result<HermesGatewayHealth> {
        let mut stream = TcpStream::connect((self.host.as_str(), self.port))
            .await
            .with_context(|| format!("failed to connect to {}", self.origin()))?;
        let request = format!(
            "GET /health HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n\r\n",
            self.origin().trim_start_matches("http://")
        );
        stream.write_all(request.as_bytes()).await?;

        let mut response = Vec::with_capacity(1024);
        let mut chunk = [0_u8; 1024];
        loop {
            let read = stream.read(&mut chunk).await?;
            if read == 0 {
                break;
            }
            if response.len() + read > RESPONSE_LIMIT {
                bail!("Hermes gateway health response exceeded {RESPONSE_LIMIT} bytes");
            }
            response.extend_from_slice(&chunk[..read]);
        }

        let split = response
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .context("Hermes gateway returned a malformed HTTP response")?;
        let headers = std::str::from_utf8(&response[..split])?;
        let status = headers.lines().next().unwrap_or_default();
        if !status.starts_with("HTTP/1.1 200 ") {
            bail!("Hermes gateway returned unexpected status: {status}");
        }
        let payload: serde_json::Value = serde_json::from_slice(&response[split + 4..])
            .context("Hermes gateway returned invalid health JSON")?;
        if !payload.is_object() {
            bail!("Hermes gateway health payload must be a JSON object");
        }
        Ok(HermesGatewayHealth {
            endpoint: self.origin(),
            payload,
            compatible: false,
            compatibility_reason: Some(
                "HTTP health fallback cannot prove the pinned Hermes CLI contract".to_owned(),
            ),
        })
    }
}

impl HermesCli {
    pub fn new(path: impl Into<PathBuf>) -> Result<Self> {
        let path = path.into();
        if !path.is_absolute() {
            bail!("Hermes CLI path must be absolute");
        }
        let metadata = std::fs::metadata(&path)
            .with_context(|| format!("Hermes CLI does not exist at {}", path.display()))?;
        if !metadata.is_file() {
            bail!("Hermes CLI path is not a file: {}", path.display());
        }
        Ok(Self { path })
    }

    pub async fn health(&self) -> Result<HermesGatewayHealth> {
        let stdout = self.run(&["--version"]).await?;
        let version = stdout
            .lines()
            .next()
            .filter(|line| !line.trim().is_empty())
            .context("Hermes CLI version output was empty")?;
        let parsed = parse_agent_version(version)?;
        let minimum = Version::parse(MINIMUM_HERMES_VERSION).expect("valid minimum Hermes version");
        let compatible = parsed >= minimum;
        Ok(HermesGatewayHealth {
            endpoint: format!("cli: {}", self.path.display()),
            payload: serde_json::json!({
                "version": version,
                "minimum_version": MINIMUM_HERMES_VERSION,
            }),
            compatible,
            compatibility_reason: (!compatible).then(|| {
                format!("Hermes {parsed} is below the validated minimum {MINIMUM_HERMES_VERSION}")
            }),
        })
    }

    pub async fn boards(&self) -> Result<Vec<HermesBoard>> {
        self.ensure_compatible().await?;
        let stdout = self.run(&["kanban", "boards", "list", "--json"]).await?;
        serde_json::from_str(&stdout).context("Hermes CLI returned invalid board JSON")
    }

    pub async fn tasks(&self, board: &str) -> Result<Vec<HermesTask>> {
        validate_board_slug(board)?;
        self.ensure_compatible().await?;
        let stdout = self
            .run(&["kanban", "--board", board, "list", "--json"])
            .await?;
        serde_json::from_str(&stdout).context("Hermes CLI returned invalid task JSON")
    }

    pub async fn create_triage_task(
        &self,
        board: &str,
        request: &CreateTaskRequest,
    ) -> Result<HermesTask> {
        validate_board_slug(board)?;
        validate_create_request(request)?;
        self.ensure_compatible().await?;
        let mut arguments = vec![
            "kanban".to_owned(),
            "--board".to_owned(),
            board.to_owned(),
            "create".to_owned(),
            request.title.clone(),
        ];
        if let Some(body) = &request.body {
            arguments.extend(["--body".to_owned(), body.clone()]);
        }
        arguments.extend([
            "--workspace".to_owned(),
            request.workspace.clone(),
            "--triage".to_owned(),
            "--idempotency-key".to_owned(),
            request.idempotency_key.clone(),
            "--created-by".to_owned(),
            "valkhana".to_owned(),
            "--json".to_owned(),
        ]);
        let references = arguments.iter().map(String::as_str).collect::<Vec<_>>();
        let stdout = self.run(&references).await?;
        serde_json::from_str(&stdout).context("Hermes CLI returned invalid created-task JSON")
    }

    pub async fn task(&self, board: &str, task_id: &str) -> Result<HermesTask> {
        validate_board_slug(board)?;
        validate_task_id(task_id)?;
        self.ensure_compatible().await?;
        let stdout = self
            .run(&["kanban", "--board", board, "show", task_id, "--json"])
            .await?;
        let detail: HermesTaskDetail = serde_json::from_str(&stdout)
            .context("Hermes CLI returned invalid task-detail JSON")?;
        Ok(detail.task)
    }

    pub async fn mutate_task(
        &self,
        board: &str,
        task_id: &str,
        mutation: &TaskMutation,
    ) -> Result<HermesTask> {
        validate_board_slug(board)?;
        validate_task_id(task_id)?;
        validate_mutation(mutation)?;
        self.ensure_compatible().await?;
        let arguments = match mutation {
            TaskMutation::Assign { profile } => vec![
                "kanban",
                "--board",
                board,
                "assign",
                task_id,
                profile.as_deref().unwrap_or("none"),
            ],
            TaskMutation::LinkDependency { child_task_id } => {
                vec!["kanban", "--board", board, "link", task_id, child_task_id]
            }
            TaskMutation::UnlinkDependency { child_task_id } => {
                vec!["kanban", "--board", board, "unlink", task_id, child_task_id]
            }
            TaskMutation::Promote { reason } => {
                vec!["kanban", "--board", board, "promote", task_id, reason]
            }
            TaskMutation::Reclaim { reason } => vec![
                "kanban", "--board", board, "reclaim", "--reason", reason, task_id,
            ],
            TaskMutation::Reassign { profile, reason } => vec![
                "kanban",
                "--board",
                board,
                "reassign",
                "--reclaim",
                "--reason",
                reason,
                task_id,
                profile.as_deref().unwrap_or("none"),
            ],
            TaskMutation::Block { reason } => vec![
                "kanban",
                "--board",
                board,
                "block",
                "--kind",
                "needs_input",
                task_id,
                reason,
            ],
            TaskMutation::RequestReview { summary } => vec![
                "kanban",
                "--board",
                board,
                "request-review",
                "--summary",
                summary,
                task_id,
            ],
            TaskMutation::RequestChanges { reason } => vec![
                "kanban",
                "--board",
                board,
                "request-changes",
                task_id,
                reason,
            ],
            TaskMutation::ReopenReview { reason } => vec![
                "kanban",
                "--board",
                board,
                "reopen-review",
                "--reason",
                reason,
                task_id,
            ],
            TaskMutation::Complete { result } => vec![
                "kanban", "--board", board, "complete", "--result", result, task_id,
            ],
            TaskMutation::Archive => vec!["kanban", "--board", board, "archive", task_id],
        };
        self.run(&arguments).await?;
        self.task(board, task_id).await
    }

    async fn ensure_compatible(&self) -> Result<()> {
        let health = self.health().await?;
        if !health.compatible {
            bail!(
                "{}",
                health
                    .compatibility_reason
                    .unwrap_or_else(|| "Hermes CLI contract is incompatible".to_owned())
            );
        }
        Ok(())
    }

    async fn run(&self, arguments: &[&str]) -> Result<String> {
        let path = self.path.clone();
        timeout(CLI_TIMEOUT, async move {
            let mut attempts = 0_u8;
            let mut child = loop {
                match tokio::process::Command::new(&path)
                    .args(arguments)
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .kill_on_drop(true)
                    .spawn()
                {
                    Ok(child) => break child,
                    Err(error) if error.raw_os_error() == Some(26) && attempts < 3 => {
                        attempts += 1;
                        sleep(Duration::from_millis(10)).await;
                    }
                    Err(error) => {
                        return Err(error).with_context(|| {
                            format!("failed to start Hermes CLI at {}", path.display())
                        });
                    }
                }
            };
            let stdout = child
                .stdout
                .take()
                .context("Hermes CLI stdout was unavailable")?;
            let stderr = child
                .stderr
                .take()
                .context("Hermes CLI stderr was unavailable")?;
            let mut bounded = stdout.take((RESPONSE_LIMIT + 1) as u64);
            let mut bounded_error = stderr.take((RESPONSE_LIMIT + 1) as u64);
            let mut output = Vec::with_capacity(1024);
            let mut error_output = Vec::with_capacity(256);
            tokio::try_join!(
                bounded.read_to_end(&mut output),
                bounded_error.read_to_end(&mut error_output)
            )?;
            if output.len() > RESPONSE_LIMIT || error_output.len() > RESPONSE_LIMIT {
                let _ = child.kill().await;
                bail!("Hermes CLI response exceeded {RESPONSE_LIMIT} bytes");
            }
            let status = child.wait().await?;
            if !status.success() {
                let detail = String::from_utf8_lossy(&error_output)
                    .lines()
                    .next()
                    .unwrap_or_default()
                    .trim()
                    .to_owned();
                if detail.is_empty() {
                    bail!("Hermes CLI command failed with {status}");
                }
                bail!("Hermes CLI command failed with {status}: {detail}");
            }
            String::from_utf8(output).context("Hermes CLI output was not UTF-8")
        })
        .await
        .context("Hermes CLI probe timed out")?
    }
}

fn parse_agent_version(line: &str) -> Result<Version> {
    let value = line
        .strip_prefix("Hermes Agent v")
        .and_then(|rest| rest.split_whitespace().next())
        .context("Hermes CLI returned an unrecognized version string")?;
    Version::parse(value).context("Hermes CLI returned an invalid semantic version")
}

fn validate_board_slug(board: &str) -> Result<()> {
    if board.is_empty()
        || board.len() > 128
        || !board
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        bail!("Hermes board must be a 1-128 character slug");
    }
    Ok(())
}

fn validate_create_request(request: &CreateTaskRequest) -> Result<()> {
    if request.title.trim().is_empty() || request.title.len() > 512 {
        bail!("Hermes task title must contain 1-512 bytes");
    }
    if request
        .body
        .as_ref()
        .is_some_and(|body| body.len() > 64 * 1024)
    {
        bail!("Hermes task body exceeds 65536 bytes");
    }
    if request.idempotency_key.is_empty()
        || request.idempotency_key.len() > 128
        || !request
            .idempotency_key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        bail!("Hermes idempotency key must be a 1-128 character identifier");
    }
    if !matches!(request.workspace.as_str(), "worktree" | "scratch") {
        bail!("Hermes task workspace must be worktree or scratch");
    }
    Ok(())
}

fn validate_task_id(task_id: &str) -> Result<()> {
    if task_id.is_empty()
        || task_id.len() > 128
        || !task_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        bail!("Hermes task ID must be a 1-128 character identifier");
    }
    Ok(())
}

fn validate_mutation(mutation: &TaskMutation) -> Result<()> {
    let text = match mutation {
        TaskMutation::Assign { profile } => {
            validate_optional_profile(profile.as_deref())?;
            None
        }
        TaskMutation::LinkDependency { child_task_id }
        | TaskMutation::UnlinkDependency { child_task_id } => {
            validate_task_id(child_task_id)?;
            None
        }
        TaskMutation::Promote { reason } => Some(("promotion reason", reason)),
        TaskMutation::Reclaim { reason } => Some(("reclaim reason", reason)),
        TaskMutation::Reassign { profile, reason } => {
            validate_optional_profile(profile.as_deref())?;
            Some(("reassignment reason", reason))
        }
        TaskMutation::Block { reason } => Some(("block reason", reason)),
        TaskMutation::RequestReview { summary } => Some(("review summary", summary)),
        TaskMutation::RequestChanges { reason } => Some(("requested changes", reason)),
        TaskMutation::ReopenReview { reason } => Some(("review reopen reason", reason)),
        TaskMutation::Complete { result } => Some(("completion result", result)),
        TaskMutation::Archive => None,
    };
    if let Some((name, value)) = text
        && (value.trim().is_empty() || value.len() > 4096)
    {
        bail!("Hermes {name} must contain 1-4096 bytes");
    }
    Ok(())
}

fn validate_optional_profile(profile: Option<&str>) -> Result<()> {
    if let Some(profile) = profile
        && (profile.is_empty()
            || profile.len() > 128
            || !profile
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.')))
    {
        bail!("Hermes profile must be a 1-128 character identifier");
    }
    Ok(())
}

impl HermesAdapter {
    pub fn from_env() -> Result<Self> {
        if let Some(path) = std::env::var_os("HERMES_CLI_BIN") {
            return Ok(Self::Cli(HermesCli::new(path)?));
        }
        if let Some(home) = std::env::var_os("HOME") {
            let candidate = Path::new(&home).join(".hermes/hermes-agent/venv/bin/hermes");
            if candidate.is_file() {
                return Ok(Self::Cli(HermesCli::new(candidate)?));
            }
        }
        Ok(Self::Gateway(HermesGatewayEndpoint::from_env()?))
    }

    pub async fn health(&self) -> Result<HermesGatewayHealth> {
        match self {
            Self::Cli(cli) => cli.health().await,
            Self::Gateway(gateway) => gateway.health().await,
        }
    }

    pub async fn boards(&self) -> Result<Vec<HermesBoard>> {
        match self {
            Self::Cli(cli) => cli.boards().await,
            Self::Gateway(_) => bail!(
                "Hermes board discovery requires the supported CLI contract on this deployment"
            ),
        }
    }

    pub async fn tasks(&self, board: &str) -> Result<Vec<HermesTask>> {
        match self {
            Self::Cli(cli) => cli.tasks(board).await,
            Self::Gateway(_) => bail!(
                "Hermes task discovery requires the supported CLI contract on this deployment"
            ),
        }
    }

    pub async fn create_triage_task(
        &self,
        board: &str,
        request: &CreateTaskRequest,
    ) -> Result<HermesTask> {
        match self {
            Self::Cli(cli) => cli.create_triage_task(board, request).await,
            Self::Gateway(_) => {
                bail!("Hermes task creation requires the supported CLI contract on this deployment")
            }
        }
    }

    pub async fn task(&self, board: &str, task_id: &str) -> Result<HermesTask> {
        match self {
            Self::Cli(cli) => cli.task(board, task_id).await,
            Self::Gateway(_) => {
                bail!("Hermes task detail requires the supported CLI contract on this deployment")
            }
        }
    }

    pub async fn mutate_task(
        &self,
        board: &str,
        task_id: &str,
        mutation: &TaskMutation,
    ) -> Result<HermesTask> {
        match self {
            Self::Cli(cli) => cli.mutate_task(board, task_id, mutation).await,
            Self::Gateway(_) => {
                bail!("Hermes task mutation requires the supported CLI contract on this deployment")
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use super::*;
    use tokio::net::TcpListener;

    #[test]
    fn accepts_only_plain_loopback_origins() {
        assert!(HermesGatewayEndpoint::parse("http://127.0.0.1:8642").is_ok());
        assert!(HermesGatewayEndpoint::parse("http://[::1]:8642").is_ok());
        assert!(HermesGatewayEndpoint::parse("http://localhost:8642").is_ok());

        for invalid in [
            "https://127.0.0.1:8642",
            "http://192.168.1.2:8642",
            "http://127.0.0.1:8642/path",
            "http://user:secret@127.0.0.1:8642",
            "http://127.0.0.1:8642?token=secret",
        ] {
            assert!(HermesGatewayEndpoint::parse(invalid).is_err(), "{invalid}");
        }
    }

    #[tokio::test]
    async fn reads_bounded_json_health() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let port = listener.local_addr().expect("address").port();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.expect("accept");
            let mut request = [0_u8; 256];
            let read = stream.read(&mut request).await.expect("request");
            assert!(String::from_utf8_lossy(&request[..read]).starts_with("GET /health "));
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{\"status\":\"ok\"}",
                )
                .await
                .expect("response");
        });

        let endpoint =
            HermesGatewayEndpoint::parse(&format!("http://127.0.0.1:{port}")).expect("endpoint");
        let health = endpoint.health().await.expect("health");

        assert_eq!(health.payload["status"], "ok");
    }

    #[tokio::test]
    async fn probes_an_explicit_hermes_cli_without_shell_interpolation() {
        let directory = tempfile::tempdir().expect("tempdir");
        let cli = directory.path().join("hermes");
        std::fs::write(&cli, "#!/bin/sh\nprintf 'Hermes Agent v0.20.0 (test)\\n'\n")
            .expect("write CLI");
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o700))
            .expect("permissions");

        let health = HermesCli::new(&cli)
            .expect("CLI")
            .health()
            .await
            .expect("probe");

        assert_eq!(health.payload["version"], "Hermes Agent v0.20.0 (test)");
        assert!(!health.compatible);
        assert!(HermesCli::new("relative/hermes").is_err());
    }

    #[tokio::test]
    async fn accepts_the_validated_hermes_floor() {
        let directory = tempfile::tempdir().expect("tempdir");
        let cli = directory.path().join("hermes");
        std::fs::write(&cli, "#!/bin/sh\nprintf 'Hermes Agent v0.20.2 (test)\\n'\n")
            .expect("write CLI");
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o700))
            .expect("permissions");

        let health = HermesCli::new(&cli)
            .expect("CLI")
            .health()
            .await
            .expect("probe");

        assert!(health.compatible);
        assert_eq!(health.payload["minimum_version"], MINIMUM_HERMES_VERSION);
    }

    #[tokio::test]
    async fn projects_typed_tasks_from_an_explicit_board() {
        let directory = tempfile::tempdir().expect("tempdir");
        let cli = directory.path().join("hermes");
        std::fs::write(
            &cli,
            r#"#!/bin/sh
if [ "$1" = --version ]; then
  printf 'Hermes Agent v0.20.2 (test)\n'
  exit 0
fi
test "$1" = kanban
test "$2" = --board
test "$3" = project-one
test "$4" = list
test "$5" = --json
printf '%s\n' '[{"id":"t_123","title":"Build","body":null,"assignee":null,"status":"blocked","priority":0,"workspace_kind":"scratch","workspace_path":null,"branch_name":null,"created_by":"codex","created_at":1,"started_at":null,"completed_at":null,"result":null,"skills":[],"max_retries":1,"model_override":null,"provider_override":null,"session_id":null}]'
"#,
        )
        .expect("write CLI");
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o700))
            .expect("permissions");

        let tasks = HermesCli::new(&cli)
            .expect("CLI")
            .tasks("project-one")
            .await
            .expect("tasks");
        assert_eq!(tasks[0].id, "t_123");
        assert_eq!(tasks[0].status, HermesTaskStatus::Blocked);
        assert!(
            HermesCli::new(&cli)
                .unwrap()
                .tasks("../../unsafe")
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn creates_only_idempotent_triage_tasks_with_an_explicit_workspace() {
        let directory = tempfile::tempdir().expect("tempdir");
        let cli = directory.path().join("hermes");
        std::fs::write(
            &cli,
            r#"#!/bin/sh
if [ "$1" = --version ]; then printf 'Hermes Agent v0.20.2 (test)\n'; exit 0; fi
test "$1" = kanban && test "$2" = --board && test "$3" = project-one
test "$4" = create && test "$5" = Build
test "$6" = --body && test "$7" = Details
test "$8" = --workspace && test "$9" = worktree
test "${10}" = --triage && test "${11}" = --idempotency-key
test "${12}" = request-1 && test "${13}" = --created-by
test "${14}" = valkhana && test "${15}" = --json
printf '%s\n' '{"id":"t_new","title":"Build","body":"Details","assignee":null,"status":"triage","priority":0,"workspace_kind":"worktree","workspace_path":null,"branch_name":null,"created_by":"valkhana","created_at":1,"started_at":null,"completed_at":null,"result":null,"skills":[],"max_retries":null,"model_override":null,"provider_override":null,"session_id":null}'
"#,
        )
        .expect("write CLI");
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o700))
            .expect("permissions");
        let cli = HermesCli::new(&cli).unwrap();
        let request = CreateTaskRequest {
            title: "Build".into(),
            body: Some("Details".into()),
            idempotency_key: "request-1".into(),
            workspace: "worktree".into(),
        };

        let task = cli
            .create_triage_task("project-one", &request)
            .await
            .unwrap();
        assert_eq!(task.id, "t_new");
        assert_eq!(task.status, HermesTaskStatus::Triage);

        let mut invalid = request;
        invalid.idempotency_key = "../unsafe".into();
        assert!(
            cli.create_triage_task("project-one", &invalid)
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn uses_supported_manual_lifecycle_commands_then_reads_back_state() {
        let directory = tempfile::tempdir().expect("tempdir");
        let cli_path = directory.path().join("hermes");
        std::fs::write(
            &cli_path,
            r#"#!/bin/sh
if [ "$1" = --version ]; then printf 'Hermes Agent v0.20.2 (test)\n'; exit 0; fi
test "$1" = kanban && test "$2" = --board && test "$3" = project-one
STATE="$0.state"
case "$4" in
  block) test "$5" = --kind && test "$6" = needs_input && test "$7" = t_123 && test "$8" = reason; printf blocked > "$STATE" ;;
  request-review) test "$5" = --summary && test "$6" = summary && test "$7" = t_123; printf review > "$STATE" ;;
  complete) test "$5" = --result && test "$6" = result && test "$7" = t_123; printf done > "$STATE" ;;
  archive) test "$5" = t_123; printf archived > "$STATE" ;;
  show)
    test "$5" = t_123 && test "$6" = --json
    STATUS=$(cat "$STATE")
    printf '{"task":{"id":"t_123","title":"Build","body":null,"assignee":null,"status":"%s","priority":0,"workspace_kind":"scratch","workspace_path":null,"branch_name":null,"created_by":"valkhana","created_at":1,"started_at":null,"completed_at":null,"result":null,"skills":[],"max_retries":null,"model_override":null,"provider_override":null,"session_id":null}}\n' "$STATUS"
    ;;
  *) exit 2 ;;
esac
"#,
        )
        .expect("write CLI");
        std::fs::set_permissions(&cli_path, std::fs::Permissions::from_mode(0o700))
            .expect("permissions");
        let cli = HermesCli::new(&cli_path).unwrap();

        for (mutation, expected) in [
            (
                TaskMutation::Block {
                    reason: "reason".into(),
                },
                HermesTaskStatus::Blocked,
            ),
            (
                TaskMutation::RequestReview {
                    summary: "summary".into(),
                },
                HermesTaskStatus::Review,
            ),
            (
                TaskMutation::Complete {
                    result: "result".into(),
                },
                HermesTaskStatus::Done,
            ),
            (TaskMutation::Archive, HermesTaskStatus::Archived),
        ] {
            let task = cli
                .mutate_task("project-one", "t_123", &mutation)
                .await
                .unwrap();
            assert_eq!(task.status, expected);
        }
        assert!(
            cli.mutate_task("project-one", "../unsafe", &TaskMutation::Archive)
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn uses_qualified_assignment_dependency_recovery_and_rework_commands() {
        let directory = tempfile::tempdir().expect("tempdir");
        let cli_path = directory.path().join("hermes");
        std::fs::write(
            &cli_path,
            r#"#!/bin/sh
if [ "$1" = --version ]; then printf 'Hermes Agent v0.20.2 (test)\n'; exit 0; fi
test "$1" = kanban && test "$2" = --board && test "$3" = project-one
case "$4" in
  assign) test "$5" = t_123 && test "$6" = builder ;;
  link) test "$5" = t_123 && test "$6" = t_child ;;
  unlink) test "$5" = t_123 && test "$6" = t_child ;;
  promote) test "$5" = t_123 && test "$6" = approved ;;
  reclaim) test "$5" = --reason && test "$6" = stale && test "$7" = t_123 ;;
  reassign) test "$5" = --reclaim && test "$6" = --reason && test "$7" = reroute && test "$8" = t_123 && test "$9" = reviewer ;;
  request-changes) test "$5" = t_123 && test "$6" = revise ;;
  reopen-review) test "$5" = --reason && test "$6" = rework && test "$7" = t_123 ;;
  show)
    test "$5" = t_123 && test "$6" = --json
    printf '%s\n' '{"task":{"id":"t_123","title":"Build","body":null,"assignee":"builder","status":"ready","priority":0,"workspace_kind":"scratch","workspace_path":null,"branch_name":null,"created_by":"valkhana","created_at":1,"started_at":null,"completed_at":null,"result":null,"skills":[],"max_retries":null,"model_override":null,"provider_override":null,"session_id":null}}'
    ;;
  *) exit 2 ;;
esac
"#,
        )
        .expect("write CLI");
        std::fs::set_permissions(&cli_path, std::fs::Permissions::from_mode(0o700))
            .expect("permissions");
        let cli = HermesCli::new(&cli_path).unwrap();

        for mutation in [
            TaskMutation::Assign {
                profile: Some("builder".into()),
            },
            TaskMutation::LinkDependency {
                child_task_id: "t_child".into(),
            },
            TaskMutation::UnlinkDependency {
                child_task_id: "t_child".into(),
            },
            TaskMutation::Promote {
                reason: "approved".into(),
            },
            TaskMutation::Reclaim {
                reason: "stale".into(),
            },
            TaskMutation::Reassign {
                profile: Some("reviewer".into()),
                reason: "reroute".into(),
            },
            TaskMutation::RequestChanges {
                reason: "revise".into(),
            },
            TaskMutation::ReopenReview {
                reason: "rework".into(),
            },
        ] {
            let task = cli
                .mutate_task("project-one", "t_123", &mutation)
                .await
                .unwrap();
            assert_eq!(task.status, HermesTaskStatus::Ready);
        }

        assert!(
            cli.mutate_task(
                "project-one",
                "t_123",
                &TaskMutation::Assign {
                    profile: Some("../unsafe".into()),
                },
            )
            .await
            .is_err()
        );
        assert!(
            cli.mutate_task(
                "project-one",
                "t_123",
                &TaskMutation::Promote { reason: "".into() },
            )
            .await
            .is_err()
        );
    }

    #[tokio::test]
    async fn projects_typed_board_discovery_from_the_cli() {
        let directory = tempfile::tempdir().expect("tempdir");
        let cli = directory.path().join("hermes");
        std::fs::write(
            &cli,
            "#!/bin/sh\nif [ \"$1\" = --version ]; then\n  printf 'Hermes Agent v0.20.2 (test)\\n'\nelif [ \"$*\" = 'kanban boards list --json' ]; then\n  printf '%s\\n' '[{\"slug\":\"default\",\"name\":\"Default\",\"archived\":false,\"is_current\":true,\"counts\":{\"blocked\":2},\"total\":2}]'\nelse\n  exit 2\nfi\n",
        )
        .expect("write CLI");
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o700))
            .expect("permissions");

        let boards = HermesCli::new(&cli)
            .expect("CLI")
            .boards()
            .await
            .expect("boards");

        assert_eq!(boards.len(), 1);
        assert_eq!(boards[0].slug, "default");
        assert_eq!(boards[0].counts["blocked"], 2);
        assert!(boards[0].is_current);
    }
}
