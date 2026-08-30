use std::{
    collections::BTreeMap,
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path as FsPath, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result};
use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
};
use rusqlite::{Connection, ErrorCode, params};
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use tracing::warn;
use valkhana_config::{ProjectMapping, ProjectWorkspace};
use valkhana_domain::HealthResponse;
use valkhana_events::{EventEnvelope, EventJournal, EventOutcome};
use valkhana_hermes::{CreateTaskRequest, HermesAdapter, HermesGatewayEndpoint, TaskMutation};
use valkhana_policy::{PolicyAuthorization, PolicyEvaluationInput, PolicyService, RiskClass};
use valkhana_secrets::{
    SecretId, SecretStore, ServiceRequest, load_dashboard_service_keys,
    verify_service_request_signature,
};

const VERSION: &str = env!("CARGO_PKG_VERSION");
const DASHBOARD_SERVICE_ID: &str = "service:valkhana-dashboard";
const SERVICE_REQUEST_WINDOW_MS: u64 = 30_000;

pub fn app() -> Result<Router> {
    Ok(app_with_adapter(HermesAdapter::from_env()?))
}

pub fn app_with_hermes(endpoint: HermesGatewayEndpoint) -> Router {
    app_with_adapter(HermesAdapter::Gateway(endpoint))
}

pub fn app_with_adapter(adapter: HermesAdapter) -> Router {
    app_with_config(adapter, None)
}

#[derive(Clone)]
struct CoreState {
    hermes: HermesAdapter,
    project: Option<ProjectMapping>,
    policy: Option<PolicyService>,
    service_auth: Option<ServiceAuthState>,
    events: EventJournal,
}

#[derive(Clone)]
struct ServiceAuthState {
    store: Arc<dyn SecretStore>,
    nonce_replay: NonceReplayLedger,
}

#[derive(Clone)]
enum NonceReplayLedger {
    InMemory(Arc<Mutex<BTreeMap<[u8; 32], u64>>>),
    Persistent(PersistentNonceReplayLedger),
}

#[derive(Clone)]
pub struct PersistentNonceReplayLedger {
    path: Arc<PathBuf>,
}

impl PersistentNonceReplayLedger {
    pub fn open(state_dir: &FsPath) -> Result<Self> {
        if !state_dir.is_absolute() {
            anyhow::bail!("ValKhana state directory must be absolute");
        }
        let directory = state_dir.join("service-auth");
        fs::create_dir_all(&directory)
            .with_context(|| format!("failed to create {}", directory.display()))?;
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))?;
        let path = directory.join("nonce-replay.db");
        let ledger = Self {
            path: Arc::new(path),
        };
        ledger.initialize()?;
        Ok(ledger)
    }

    fn initialize(&self) -> Result<()> {
        let connection = self.connection()?;
        connection.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = FULL;
             CREATE TABLE IF NOT EXISTS consumed_nonces (
                 nonce_sha256 BLOB PRIMARY KEY NOT NULL,
                 expires_at_unix_ms INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS consumed_nonces_expiry ON consumed_nonces(expires_at_unix_ms);",
        )?;
        Ok(())
    }

    fn connection(&self) -> Result<Connection> {
        let connection = Connection::open(self.path.as_ref())
            .with_context(|| format!("failed to open {}", self.path.display()))?;
        fs::set_permissions(self.path.as_ref(), fs::Permissions::from_mode(0o600))?;
        Ok(connection)
    }

    fn consume(
        &self,
        nonce_sha256: [u8; 32],
        expires_at_unix_ms: u64,
        now_unix_ms: u64,
    ) -> Result<bool> {
        let mut connection = self.connection()?;
        let transaction =
            connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        transaction.execute(
            "DELETE FROM consumed_nonces WHERE expires_at_unix_ms < ?1",
            params![i64::try_from(now_unix_ms)?],
        )?;
        let inserted = match transaction.execute(
            "INSERT INTO consumed_nonces (nonce_sha256, expires_at_unix_ms) VALUES (?1, ?2)",
            params![nonce_sha256.as_slice(), i64::try_from(expires_at_unix_ms)?],
        ) {
            Ok(_) => true,
            Err(rusqlite::Error::SqliteFailure(error, _))
                if error.code == ErrorCode::ConstraintViolation =>
            {
                false
            }
            Err(error) => return Err(error.into()),
        };
        transaction.commit()?;
        Ok(inserted)
    }
}

impl NonceReplayLedger {
    fn in_memory() -> Self {
        Self::InMemory(Arc::new(Mutex::new(BTreeMap::new())))
    }

    fn consume(&self, nonce: &str, expires_at_unix_ms: u64, now_unix_ms: u64) -> Result<bool> {
        let nonce_sha256: [u8; 32] = Sha256::digest(nonce.as_bytes()).into();
        match self {
            Self::InMemory(nonces) => {
                let mut nonces = nonces
                    .lock()
                    .map_err(|_| anyhow::anyhow!("nonce replay lock poisoned"))?;
                nonces.retain(|_, expires_at| *expires_at >= now_unix_ms);
                Ok(nonces.insert(nonce_sha256, expires_at_unix_ms).is_none())
            }
            Self::Persistent(ledger) => {
                ledger.consume(nonce_sha256, expires_at_unix_ms, now_unix_ms)
            }
        }
    }
}

pub fn app_with_config(adapter: HermesAdapter, project: Option<ProjectMapping>) -> Router {
    app_with_runtime(adapter, project, None)
}

pub fn app_with_runtime(
    adapter: HermesAdapter,
    project: Option<ProjectMapping>,
    policy: Option<PolicyService>,
) -> Router {
    app_with_services(adapter, project, policy, None)
}

pub fn app_with_services(
    adapter: HermesAdapter,
    project: Option<ProjectMapping>,
    policy: Option<PolicyService>,
    secret_store: Option<Arc<dyn SecretStore>>,
) -> Router {
    app_with_event_journal(
        adapter,
        project,
        policy,
        secret_store,
        EventJournal::default(),
    )
}

pub fn app_with_persistent_nonce_ledger(
    adapter: HermesAdapter,
    project: Option<ProjectMapping>,
    policy: Option<PolicyService>,
    secret_store: Option<Arc<dyn SecretStore>>,
    nonce_replay: PersistentNonceReplayLedger,
) -> Router {
    app_with_services_and_nonce_ledger(
        adapter,
        project,
        policy,
        secret_store,
        EventJournal::default(),
        NonceReplayLedger::Persistent(nonce_replay),
    )
}

pub fn app_with_event_journal(
    adapter: HermesAdapter,
    project: Option<ProjectMapping>,
    policy: Option<PolicyService>,
    secret_store: Option<Arc<dyn SecretStore>>,
    events: EventJournal,
) -> Router {
    app_with_services_and_nonce_ledger(
        adapter,
        project,
        policy,
        secret_store,
        events,
        NonceReplayLedger::in_memory(),
    )
}

fn app_with_services_and_nonce_ledger(
    adapter: HermesAdapter,
    project: Option<ProjectMapping>,
    policy: Option<PolicyService>,
    secret_store: Option<Arc<dyn SecretStore>>,
    events: EventJournal,
    nonce_replay: NonceReplayLedger,
) -> Router {
    Router::new()
        .route("/v1/health", get(health))
        .route("/health", get(health))
        .route("/v1/auth/service/probe", post(service_auth_probe))
        .route("/v1/integrations/hermes/health", get(hermes_health))
        .route("/v1/integrations/hermes/boards", get(hermes_boards))
        .route(
            "/v1/integrations/hermes/tasks",
            get(hermes_tasks).post(create_hermes_task),
        )
        .route(
            "/v1/integrations/hermes/tasks/{task_id}",
            get(hermes_task)
                .patch(mutate_hermes_task)
                .delete(archive_hermes_task),
        )
        .route(
            "/v1/policy/decisions",
            get(recent_policy_decisions).post(evaluate_policy),
        )
        .route("/v1/policy/approvals", get(recent_policy_approvals))
        .route("/v1/policy/approvals/{approval_id}", get(policy_approval))
        .route("/v1/events", get(recent_events))
        .with_state(CoreState {
            hermes: adapter,
            project,
            policy,
            service_auth: secret_store.map(|store| ServiceAuthState {
                store,
                nonce_replay,
            }),
            events,
        })
}

async fn service_auth_probe(
    State(state): State<CoreState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    match authenticate_dashboard_service(
        &state,
        &headers,
        "POST",
        "/v1/auth/service/probe",
        "probe",
        b"",
    )
    .await
    {
        Ok(()) => (
            StatusCode::OK,
            Json(json!({ "service_id": DASHBOARD_SERVICE_ID, "authenticated": true })),
        ),
        Err(response) => response,
    }
}

async fn authenticate_dashboard_service(
    state: &CoreState,
    headers: &HeaderMap,
    method: &str,
    path: &str,
    action: &str,
    payload: &[u8],
) -> std::result::Result<(), (StatusCode, Json<serde_json::Value>)> {
    let unavailable = || {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "dashboard service authentication is unavailable" })),
        )
    };
    let unauthorized = || {
        (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "invalid dashboard service authentication" })),
        )
    };
    let Some(auth) = state.service_auth.clone() else {
        return Err(unavailable());
    };
    let header = |name: &'static str| {
        headers
            .get(name)
            .and_then(|value| value.to_str().ok())
            .ok_or_else(unauthorized)
    };
    if header("x-valkhana-service-id")? != DASHBOARD_SERVICE_ID {
        return Err(unauthorized());
    }
    let timestamp = header("x-valkhana-timestamp")?
        .parse::<u64>()
        .map_err(|_| unauthorized())?;
    let nonce = header("x-valkhana-nonce")?;
    if nonce.len() != 32
        || !nonce
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(unauthorized());
    }
    let signature = header("x-valkhana-signature")?;
    let now = unix_time_ms().map_err(|_| unavailable())?;
    if now.abs_diff(timestamp) > SERVICE_REQUEST_WINDOW_MS {
        return Err(unauthorized());
    }

    let store = auth.store.clone();
    let keys = tokio::task::spawn_blocking(move || load_dashboard_service_keys(&*store, now))
        .await
        .map_err(|_| unavailable())?
        .map_err(|_| unavailable())?;
    let service_id = SecretId::parse(DASHBOARD_SERVICE_ID).map_err(|_| unavailable())?;
    let request = ServiceRequest {
        service_id: &service_id,
        method,
        path,
        action,
        payload_sha256: Sha256::digest(payload).into(),
        timestamp_unix_ms: timestamp,
        nonce,
    };
    let signature_valid = keys.iter().try_fold(false, |valid, key| {
        verify_service_request_signature(key.expose(), &request, signature)
            .map(|matches| valid | matches)
    });
    if !signature_valid.map_err(|_| unauthorized())? {
        return Err(unauthorized());
    }

    let ledger = auth.nonce_replay.clone();
    let nonce = nonce.to_owned();
    let expires_at_unix_ms = timestamp.saturating_add(SERVICE_REQUEST_WINDOW_MS);
    let consumed =
        tokio::task::spawn_blocking(move || ledger.consume(&nonce, expires_at_unix_ms, now))
            .await
            .map_err(|_| unavailable())?
            .map_err(|_| unavailable())?;
    if !consumed {
        return Err(unauthorized());
    }
    Ok(())
}

fn unix_time_ms() -> Result<u64> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .context("system clock is before the Unix epoch")?;
    u64::try_from(now.as_millis()).context("system clock exceeds supported timestamps")
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse::healthy(VERSION))
}

#[derive(Deserialize)]
struct EventsQuery {
    limit: Option<usize>,
}

async fn recent_events(
    State(state): State<CoreState>,
    Query(query): Query<EventsQuery>,
) -> impl IntoResponse {
    match state.events.recent(query.limit.unwrap_or(100)) {
        Ok(events) => (StatusCode::OK, Json(json!({ "events": events }))),
        Err(error) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "events": [], "error": error.to_string() })),
        ),
    }
}

#[derive(Deserialize)]
struct PolicyDecisionsQuery {
    limit: Option<usize>,
}

async fn recent_policy_decisions(
    State(state): State<CoreState>,
    Query(query): Query<PolicyDecisionsQuery>,
) -> impl IntoResponse {
    let Some(policy) = state.policy else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "decisions": [], "error": "policy service is unavailable" })),
        );
    };
    match policy.recent(query.limit.unwrap_or(100)) {
        Ok(decisions) => (StatusCode::OK, Json(json!({ "decisions": decisions }))),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "decisions": [], "error": error.to_string() })),
        ),
    }
}

async fn evaluate_policy(
    State(state): State<CoreState>,
    Json(input): Json<PolicyEvaluationInput>,
) -> impl IntoResponse {
    let Some(policy) = state.policy else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "policy service is unavailable" })),
        );
    };
    match policy.authorize(input) {
        Ok(authorization) => {
            record_policy_projection(&state.events, authorization.record());
            let status = match &authorization {
                PolicyAuthorization::Authorized(_) => StatusCode::OK,
                PolicyAuthorization::Denied(_) => StatusCode::FORBIDDEN,
                PolicyAuthorization::ApprovalRequired(_) => StatusCode::ACCEPTED,
            };
            (
                status,
                Json(json!({ "decision": authorization.into_record() })),
            )
        }
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": error.to_string() })),
        ),
    }
}

fn record_policy_projection(
    events: &EventJournal,
    decision: &valkhana_policy::PolicyDecisionRecord,
) {
    let mut event = EventEnvelope::new(
        decision.timestamp_unix_ms.to_string(),
        "valkhana-core",
        "policy.decision",
    );
    event.request_id = decision.correlation_id.clone();
    event.hermes_task_id = decision.task_id.clone();
    event.outcome = Some(match decision.decision {
        valkhana_policy::PolicyDecision::Allow => EventOutcome::Success,
        valkhana_policy::PolicyDecision::Deny => EventOutcome::Denied,
        valkhana_policy::PolicyDecision::RequireHumanApproval => EventOutcome::Denied,
    });
    event.metadata = json!({
        "capability": decision.capability,
        "policy_decision": match decision.decision {
            valkhana_policy::PolicyDecision::Allow => "allow",
            valkhana_policy::PolicyDecision::Deny => "deny",
            valkhana_policy::PolicyDecision::RequireHumanApproval => "require_human_approval",
        }
    });
    if let Err(error) = events.record(event) {
        warn!(%error, decision_id = %decision.decision_id, "failed to project persisted policy decision into event journal");
    }
}

async fn recent_policy_approvals(
    State(state): State<CoreState>,
    Query(query): Query<PolicyDecisionsQuery>,
) -> impl IntoResponse {
    let Some(policy) = state.policy else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "approvals": [], "error": "policy service is unavailable" })),
        );
    };
    match policy.recent_approvals(query.limit.unwrap_or(100)) {
        Ok(approvals) => (StatusCode::OK, Json(json!({ "approvals": approvals }))),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "approvals": [], "error": error.to_string() })),
        ),
    }
}

async fn policy_approval(
    State(state): State<CoreState>,
    Path(approval_id): Path<String>,
) -> impl IntoResponse {
    let Some(policy) = state.policy else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "policy service is unavailable" })),
        );
    };
    match policy.approval(&approval_id) {
        Ok(Some(approval)) => (StatusCode::OK, Json(json!({ "approval": approval }))),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "policy approval was not found" })),
        ),
        Err(error) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": error.to_string() })),
        ),
    }
}

async fn hermes_health(State(state): State<CoreState>) -> impl IntoResponse {
    let adapter = state.hermes;
    match adapter.health().await {
        Ok(health) => {
            let status_code = if health.compatible {
                StatusCode::OK
            } else {
                StatusCode::SERVICE_UNAVAILABLE
            };
            let status = if health.compatible {
                "connected"
            } else {
                "incompatible"
            };
            (
                status_code,
                Json(json!({
                    "name": "hermes",
                    "status": status,
                    "endpoint": health.endpoint,
                    "payload": health.payload,
                    "compatibility_reason": health.compatibility_reason,
                })),
            )
        }
        Err(error) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({
                "name": "hermes",
                "status": "offline",
                "error": error.to_string(),
            })),
        ),
    }
}

async fn hermes_boards(State(state): State<CoreState>) -> impl IntoResponse {
    let adapter = state.hermes;
    match adapter.boards().await {
        Ok(boards) => (StatusCode::OK, Json(json!({ "boards": boards }))),
        Err(error) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "boards": [], "error": error.to_string() })),
        ),
    }
}

#[derive(Deserialize)]
struct HermesTasksQuery {
    board: Option<String>,
}

async fn hermes_tasks(
    State(state): State<CoreState>,
    Query(query): Query<HermesTasksQuery>,
) -> impl IntoResponse {
    let board = match query
        .board
        .or_else(|| state.project.map(|project| project.hermes_board))
    {
        Some(board) => board,
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(
                    json!({ "tasks": [], "error": "board query or configured project mapping is required" }),
                ),
            );
        }
    };
    match state.hermes.tasks(&board).await {
        Ok(tasks) => (
            StatusCode::OK,
            Json(json!({ "board": board, "tasks": tasks })),
        ),
        Err(error) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "board": board, "tasks": [], "error": error.to_string() })),
        ),
    }
}

#[derive(Deserialize)]
struct CreateHermesTaskBody {
    title: String,
    #[serde(default, alias = "description")]
    body: Option<String>,
    idempotency_key: String,
}

async fn create_hermes_task(
    State(state): State<CoreState>,
    Json(body): Json<CreateHermesTaskBody>,
) -> impl IntoResponse {
    let project = match state.project.clone() {
        Some(project) => project,
        None => {
            return (
                StatusCode::PRECONDITION_FAILED,
                Json(
                    json!({ "error": "configured project mapping is required for task creation" }),
                ),
            );
        }
    };
    if body.title.trim().is_empty()
        || body.title.len() > 512
        || body.idempotency_key.is_empty()
        || body.idempotency_key.len() > 128
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "valid title and idempotency_key are required" })),
        );
    }
    let Some(policy) = state.policy.clone() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "policy service is unavailable; task admission fails closed" })),
        );
    };
    let authorization = match policy.authorize(PolicyEvaluationInput {
        principal: "service:valkhana".into(),
        task_id: None,
        project_id: Some(project.id.clone()),
        capability: "hermes:task-admit-triage".into(),
        target: format!("hermes-board:{}", project.hermes_board),
        risk: RiskClass::Low,
        correlation_id: Some(body.idempotency_key.clone()),
    }) {
        Ok(authorization) => authorization,
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": format!("policy evaluation failed: {error}") })),
            );
        }
    };
    record_policy_projection(&state.events, authorization.record());
    match authorization {
        PolicyAuthorization::Authorized(_) => {}
        PolicyAuthorization::Denied(decision) => {
            return (
                StatusCode::FORBIDDEN,
                Json(json!({ "error": "task admission denied by policy", "decision": decision })),
            );
        }
        PolicyAuthorization::ApprovalRequired(decision) => {
            return (
                StatusCode::ACCEPTED,
                Json(
                    json!({ "error": "task admission requires human approval", "decision": decision }),
                ),
            );
        }
    }
    let workspace = match project.default_workspace {
        ProjectWorkspace::Worktree => "worktree",
        ProjectWorkspace::Scratch => "scratch",
    };
    let request = CreateTaskRequest {
        title: body.title,
        body: body.body,
        idempotency_key: body.idempotency_key,
        workspace: workspace.to_owned(),
    };
    match state
        .hermes
        .create_triage_task(&project.hermes_board, &request)
        .await
    {
        Ok(task) => (StatusCode::CREATED, Json(json!({ "task": task }))),
        Err(error) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": error.to_string() })),
        ),
    }
}

async fn hermes_task(
    State(state): State<CoreState>,
    Path(task_id): Path<String>,
) -> impl IntoResponse {
    let project = match state.project.clone() {
        Some(project) => project,
        None => {
            return (
                StatusCode::PRECONDITION_FAILED,
                Json(json!({ "error": "configured project mapping is required for task detail" })),
            );
        }
    };
    match state.hermes.task(&project.hermes_board, &task_id).await {
        Ok(task) => (StatusCode::OK, Json(json!({ "task": task }))),
        Err(error) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": error.to_string() })),
        ),
    }
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
enum TaskMutationBody {
    Block {
        reason: String,
    },
    RequestReview {
        summary: String,
    },
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
    RequestChanges {
        reason: String,
    },
    ReopenReview {
        reason: String,
    },
    Complete {
        result: String,
    },
}

async fn mutate_hermes_task(
    State(state): State<CoreState>,
    Path(task_id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<TaskMutationBody>,
) -> impl IntoResponse {
    let path = format!("/v1/integrations/hermes/tasks/{task_id}");
    let (mutation, policy_request) = match body {
        TaskMutationBody::Block { reason } => (
            TaskMutation::Block { reason },
            Some((
                "service:valkhana",
                "hermes:task-block-needs-input",
                RiskClass::Low,
                None,
            )),
        ),
        TaskMutationBody::RequestReview { summary } => (
            TaskMutation::RequestReview { summary },
            Some((
                "service:valkhana",
                "hermes:task-request-review",
                RiskClass::Low,
                None,
            )),
        ),
        TaskMutationBody::Assign { profile } => {
            let payload = profile.clone().unwrap_or_default();
            if let Err(response) = authenticate_protected_mutation(
                &state,
                &headers,
                &path,
                "assign",
                payload.as_bytes(),
            )
            .await
            {
                return response;
            }
            (
                TaskMutation::Assign { profile },
                Some((
                    DASHBOARD_SERVICE_ID,
                    "hermes:task-assign",
                    RiskClass::High,
                    Some(payload),
                )),
            )
        }
        TaskMutationBody::LinkDependency { child_task_id } => {
            if let Err(response) = authenticate_protected_mutation(
                &state,
                &headers,
                &path,
                "link_dependency",
                child_task_id.as_bytes(),
            )
            .await
            {
                return response;
            }
            (
                TaskMutation::LinkDependency {
                    child_task_id: child_task_id.clone(),
                },
                Some((
                    DASHBOARD_SERVICE_ID,
                    "hermes:task-link-dependency",
                    RiskClass::High,
                    Some(child_task_id),
                )),
            )
        }
        TaskMutationBody::UnlinkDependency { child_task_id } => {
            if let Err(response) = authenticate_protected_mutation(
                &state,
                &headers,
                &path,
                "unlink_dependency",
                child_task_id.as_bytes(),
            )
            .await
            {
                return response;
            }
            (
                TaskMutation::UnlinkDependency {
                    child_task_id: child_task_id.clone(),
                },
                Some((
                    DASHBOARD_SERVICE_ID,
                    "hermes:task-unlink-dependency",
                    RiskClass::High,
                    Some(child_task_id),
                )),
            )
        }
        TaskMutationBody::Promote { reason } => match protected_reason_mutation(
            &state,
            &headers,
            &path,
            "promote",
            "hermes:task-promote",
            reason,
            |reason| TaskMutation::Promote { reason },
        )
        .await
        {
            Ok(value) => value,
            Err(response) => return response,
        },
        TaskMutationBody::Reclaim { reason } => match protected_reason_mutation(
            &state,
            &headers,
            &path,
            "reclaim",
            "hermes:task-reclaim",
            reason,
            |reason| TaskMutation::Reclaim { reason },
        )
        .await
        {
            Ok(value) => value,
            Err(response) => return response,
        },
        TaskMutationBody::RequestChanges { reason } => match protected_reason_mutation(
            &state,
            &headers,
            &path,
            "request_changes",
            "hermes:task-request-changes",
            reason,
            |reason| TaskMutation::RequestChanges { reason },
        )
        .await
        {
            Ok(value) => value,
            Err(response) => return response,
        },
        TaskMutationBody::ReopenReview { reason } => match protected_reason_mutation(
            &state,
            &headers,
            &path,
            "reopen_review",
            "hermes:task-reopen-review",
            reason,
            |reason| TaskMutation::ReopenReview { reason },
        )
        .await
        {
            Ok(value) => value,
            Err(response) => return response,
        },
        TaskMutationBody::Reassign { profile, reason } => {
            let payload = format!("{}\n{reason}", profile.as_deref().unwrap_or_default());
            if let Err(response) = authenticate_protected_mutation(
                &state,
                &headers,
                &path,
                "reassign",
                payload.as_bytes(),
            )
            .await
            {
                return response;
            }
            (
                TaskMutation::Reassign { profile, reason },
                Some((
                    DASHBOARD_SERVICE_ID,
                    "hermes:task-reassign",
                    RiskClass::High,
                    Some(payload),
                )),
            )
        }
        TaskMutationBody::Complete { result } => {
            if let Err(response) = authenticate_dashboard_service(
                &state,
                &headers,
                "PATCH",
                &path,
                "complete",
                result.as_bytes(),
            )
            .await
            {
                return response;
            }
            (TaskMutation::Complete { result }, None)
        }
    };
    let project = match state.project.clone() {
        Some(project) => project,
        None => {
            return (
                StatusCode::PRECONDITION_FAILED,
                Json(
                    json!({ "error": "configured project mapping is required for task mutation" }),
                ),
            );
        }
    };
    if let Some((principal, capability, risk, protected_payload)) = policy_request {
        let Some(policy) = state.policy.clone() else {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(
                    json!({ "error": "policy service is unavailable; task mutation fails closed" }),
                ),
            );
        };
        let authorization = match policy.authorize(PolicyEvaluationInput {
            principal: principal.into(),
            task_id: Some(task_id.clone()),
            project_id: Some(project.id.clone()),
            capability: capability.into(),
            target: match protected_payload {
                Some(payload) => format!(
                    "hermes-board:{}/task:{task_id}/input:{:x}",
                    project.hermes_board,
                    Sha256::digest(payload.as_bytes())
                ),
                None => format!("hermes-board:{}/task:{task_id}", project.hermes_board),
            },
            risk,
            correlation_id: Some(format!("task-{task_id}-{capability}")),
        }) {
            Ok(authorization) => authorization,
            Err(error) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({ "error": format!("policy evaluation failed: {error}") })),
                );
            }
        };
        record_policy_projection(&state.events, authorization.record());
        match authorization {
            PolicyAuthorization::Authorized(_) => {}
            PolicyAuthorization::Denied(decision) => {
                return (
                    StatusCode::FORBIDDEN,
                    Json(
                        json!({ "error": "task mutation denied by policy", "decision": decision }),
                    ),
                );
            }
            PolicyAuthorization::ApprovalRequired(decision) => {
                return (
                    StatusCode::ACCEPTED,
                    Json(
                        json!({ "error": "task mutation requires human approval", "decision": decision }),
                    ),
                );
            }
        }
    }
    match state
        .hermes
        .mutate_task(&project.hermes_board, &task_id, &mutation)
        .await
    {
        Ok(task) => (StatusCode::OK, Json(json!({ "task": task }))),
        Err(error) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": error.to_string() })),
        ),
    }
}

async fn authenticate_protected_mutation(
    state: &CoreState,
    headers: &HeaderMap,
    path: &str,
    action: &str,
    payload: &[u8],
) -> Result<(), (StatusCode, Json<serde_json::Value>)> {
    authenticate_dashboard_service(state, headers, "PATCH", path, action, payload).await
}

async fn protected_reason_mutation(
    state: &CoreState,
    headers: &HeaderMap,
    path: &str,
    action: &'static str,
    capability: &'static str,
    reason: String,
    constructor: fn(String) -> TaskMutation,
) -> Result<
    (
        TaskMutation,
        Option<(&'static str, &'static str, RiskClass, Option<String>)>,
    ),
    (StatusCode, Json<serde_json::Value>),
> {
    authenticate_protected_mutation(state, headers, path, action, reason.as_bytes()).await?;
    Ok((
        constructor(reason.clone()),
        Some((
            DASHBOARD_SERVICE_ID,
            capability,
            RiskClass::High,
            Some(reason),
        )),
    ))
}

async fn archive_hermes_task(
    State(state): State<CoreState>,
    Path(task_id): Path<String>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let path = format!("/v1/integrations/hermes/tasks/{task_id}");
    if let Err(response) =
        authenticate_dashboard_service(&state, &headers, "DELETE", &path, "archive", b"").await
    {
        return response;
    }
    let project = match state.project.clone() {
        Some(project) => project,
        None => {
            return (
                StatusCode::PRECONDITION_FAILED,
                Json(
                    json!({ "error": "configured project mapping is required for task archival" }),
                ),
            );
        }
    };
    match state
        .hermes
        .mutate_task(&project.hermes_board, &task_id, &TaskMutation::Archive)
        .await
    {
        Ok(task) => (StatusCode::OK, Json(json!({ "task": task }))),
        Err(error) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": error.to_string() })),
        ),
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use super::*;
    use anyhow::bail;
    use axum::{
        body::{Body, to_bytes},
        http::{Method, Request, StatusCode, header},
    };
    use serde_json::{Value, json};
    use tokio::{io::AsyncReadExt, io::AsyncWriteExt, net::TcpListener};
    use tower::ServiceExt;
    use valkhana_config::ConfigSet;
    use valkhana_events::{EventEnvelope, EventJournal};
    use valkhana_policy::{ApprovalAction, PolicyConfiguration, PolicyDecision, PolicyLedger};
    use valkhana_secrets::{
        DASHBOARD_CURRENT_KEY_ID, SecretClass, SecretMetadata, SecretValue, sign_service_request,
    };

    struct FixedSecretStore(Vec<u8>);

    impl SecretStore for FixedSecretStore {
        fn get(&self, id: &SecretId) -> Result<Option<SecretValue>> {
            if id.as_str() == DASHBOARD_CURRENT_KEY_ID {
                Ok(Some(SecretValue::new(self.0.clone())?))
            } else {
                Ok(None)
            }
        }

        fn set(&self, _metadata: &SecretMetadata, _value: SecretValue) -> Result<()> {
            bail!("test store is read-only")
        }

        fn delete(&self, _id: &SecretId) -> Result<bool> {
            bail!("test store is read-only")
        }

        fn list_metadata(&self) -> Result<Vec<SecretMetadata>> {
            Ok(vec![SecretMetadata {
                id: SecretId::parse(DASHBOARD_CURRENT_KEY_ID)?,
                class: SecretClass::ServiceToken,
            }])
        }
    }

    struct SignedRequestInput<'a> {
        method: Method,
        path: &'a str,
        action: &'a str,
        payload: &'a [u8],
        timestamp: u64,
        nonce: &'a str,
        body: Body,
    }

    fn signed_request(key: &[u8], input: SignedRequestInput<'_>) -> Request<Body> {
        let service_id = SecretId::parse(DASHBOARD_SERVICE_ID).unwrap();
        let proof = ServiceRequest {
            service_id: &service_id,
            method: input.method.as_str(),
            path: input.path,
            action: input.action,
            payload_sha256: Sha256::digest(input.payload).into(),
            timestamp_unix_ms: input.timestamp,
            nonce: input.nonce,
        };
        let signature = sign_service_request(key, &proof).unwrap();
        let is_patch = input.method == Method::PATCH;
        let mut builder = Request::builder()
            .method(input.method)
            .uri(input.path)
            .header("x-valkhana-service-id", DASHBOARD_SERVICE_ID)
            .header("x-valkhana-timestamp", input.timestamp)
            .header("x-valkhana-nonce", input.nonce)
            .header("x-valkhana-signature", signature);
        if is_patch {
            builder = builder.header(header::CONTENT_TYPE, "application/json");
        }
        builder.body(input.body).unwrap()
    }

    async fn response(path: &str) -> axum::response::Response {
        app()
            .unwrap()
            .oneshot(Request::get(path).body(Body::empty()).unwrap())
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn canonical_and_compatibility_health_routes_match_the_wire_contract() {
        for path in ["/v1/health", "/health"] {
            let response = response(path).await;
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(
                response.headers().get(header::CONTENT_TYPE).unwrap(),
                "application/json"
            );
            let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
            let value: Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(
                value,
                json!({"name": "valkhana-core", "version": "0.1.0", "status": "healthy"})
            );
        }
    }

    #[test]
    fn persistent_nonce_ledger_survives_reopen_uses_digest_only_and_prunes_expired_entries() {
        let state_root = tempfile::tempdir().unwrap();
        let nonce = "a0000000000000000000000000000001";
        let ledger = PersistentNonceReplayLedger::open(state_root.path()).unwrap();
        assert!(
            ledger
                .consume(Sha256::digest(nonce.as_bytes()).into(), 200, 100)
                .unwrap()
        );
        assert_eq!(
            std::fs::metadata(state_root.path().join("service-auth"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::metadata(state_root.path().join("service-auth/nonce-replay.db"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        let reopened = PersistentNonceReplayLedger::open(state_root.path()).unwrap();
        assert!(
            !reopened
                .consume(Sha256::digest(nonce.as_bytes()).into(), 200, 101)
                .unwrap()
        );
        assert!(
            reopened
                .consume(Sha256::digest(nonce.as_bytes()).into(), 400, 201)
                .unwrap()
        );
        let bytes = std::fs::read(state_root.path().join("service-auth/nonce-replay.db")).unwrap();
        assert!(
            !bytes
                .windows(nonce.len())
                .any(|window| window == nonce.as_bytes())
        );
    }

    #[tokio::test]
    async fn persistent_nonce_ledger_rejects_a_valid_signed_request_after_router_restart() {
        let state_root = tempfile::tempdir().unwrap();
        let dashboard_key = vec![77; 32];
        let ledger = PersistentNonceReplayLedger::open(state_root.path()).unwrap();
        let app = app_with_persistent_nonce_ledger(
            HermesAdapter::from_env().unwrap(),
            None,
            None,
            Some(Arc::new(FixedSecretStore(dashboard_key.clone()))),
            ledger,
        );
        let now = unix_time_ms().unwrap();
        let input = SignedRequestInput {
            method: Method::POST,
            path: "/v1/auth/service/probe",
            action: "probe",
            payload: b"",
            timestamp: now,
            nonce: "a0000000000000000000000000000002",
            body: Body::empty(),
        };
        let accepted = app
            .oneshot(signed_request(&dashboard_key, input))
            .await
            .unwrap();
        assert_eq!(accepted.status(), StatusCode::OK);

        let restarted = app_with_persistent_nonce_ledger(
            HermesAdapter::from_env().unwrap(),
            None,
            None,
            Some(Arc::new(FixedSecretStore(dashboard_key.clone()))),
            PersistentNonceReplayLedger::open(state_root.path()).unwrap(),
        );
        let replay = restarted
            .oneshot(signed_request(
                &dashboard_key,
                SignedRequestInput {
                    method: Method::POST,
                    path: "/v1/auth/service/probe",
                    action: "probe",
                    payload: b"",
                    timestamp: now,
                    nonce: "a0000000000000000000000000000002",
                    body: Body::empty(),
                },
            ))
            .await
            .unwrap();
        assert_eq!(replay.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn events_are_bounded_read_only_metadata_projections() {
        let journal = EventJournal::new(4, 60_000).unwrap();
        let mut event =
            EventEnvelope::new("2026-08-17T03:00:00Z", "valkhana-core", "policy.denied");
        event.hermes_task_id = Some("t_123".into());
        event.metadata = json!({
            "error_category": "policy_denied",
            "prompt": "must not survive"
        });
        journal.record(event).unwrap();
        let app = app_with_event_journal(
            HermesAdapter::from_env().unwrap(),
            None,
            None,
            None,
            journal,
        );

        let response = app
            .clone()
            .oneshot(
                Request::get("/v1/events?limit=1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let value: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(value["events"][0]["event"], "policy.denied");
        assert_eq!(
            value["events"][0]["metadata"]["error_category"],
            "policy_denied"
        );
        assert_eq!(value["events"][0]["redacted_fields"], 1);
        assert!(value["events"][0]["metadata"].get("prompt").is_none());

        let invalid = app
            .clone()
            .oneshot(
                Request::get("/v1/events?limit=1001")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
        let mutation = app
            .oneshot(
                Request::post("/v1/events")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(mutation.status(), StatusCode::METHOD_NOT_ALLOWED);
    }

    #[tokio::test]
    async fn unsupported_route_and_method_are_rejected() {
        assert_eq!(response("/missing").await.status(), StatusCode::NOT_FOUND);
        let response = app()
            .unwrap()
            .oneshot(Request::post("/v1/health").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);

        let protected = app()
            .unwrap()
            .oneshot(
                Request::delete("/v1/integrations/hermes/tasks/t_123")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(protected.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn policy_decisions_are_server_evaluated_and_auditable() {
        let config_root = tempfile::tempdir().unwrap();
        std::fs::write(
            config_root.path().join("permissions.yaml"),
            "schema_version: 1\nagents:\n  agent:builder:\n    profile: workspace\n",
        )
        .unwrap();
        let config = ConfigSet::load(config_root.path()).unwrap();
        let state_root = tempfile::tempdir().unwrap();
        let policy = PolicyService::new(
            PolicyConfiguration::from_config(&config).unwrap(),
            PolicyLedger::open(state_root.path()).unwrap(),
        );
        let app = app_with_runtime(HermesAdapter::from_env().unwrap(), None, Some(policy));
        let body = json!({
            "principal": "agent:builder",
            "task_id": "task-1",
            "project_id": "valkhana",
            "capability": "worktree:read-write",
            "target": "/worktrees/task-1",
            "risk": "low",
            "correlation_id": "correlation-1"
        });
        let evaluated = app
            .clone()
            .oneshot(
                Request::post("/v1/policy/decisions")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(evaluated.status(), StatusCode::OK);
        let value: Value =
            serde_json::from_slice(&to_bytes(evaluated.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(value["decision"]["decision"], json!(PolicyDecision::Allow));
        assert_eq!(value["decision"]["approval_id"], Value::Null);

        let recent = app
            .oneshot(
                Request::get("/v1/policy/decisions?limit=1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(recent.status(), StatusCode::OK);
        let value: Value =
            serde_json::from_slice(&to_bytes(recent.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(value["decisions"].as_array().unwrap().len(), 1);
        assert_eq!(value["decisions"][0]["decision"], "allow");
    }

    #[tokio::test]
    async fn policy_endpoint_fails_closed_without_initialized_service() {
        let response = app()
            .unwrap()
            .oneshot(
                Request::post("/v1/policy/decisions")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({
                            "principal": "agent:builder",
                            "capability": "task:read",
                            "target": "task-1",
                            "risk": "low"
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn elevated_policy_request_creates_a_read_only_pending_approval() {
        let state_root = tempfile::tempdir().unwrap();
        let policy = PolicyService::new(
            PolicyConfiguration::default(),
            PolicyLedger::open(state_root.path()).unwrap(),
        );
        let app = app_with_runtime(HermesAdapter::from_env().unwrap(), None, Some(policy));
        let request_body = json!({
            "principal": "agent:builder",
            "task_id": "task-1",
            "project_id": "valkhana",
            "capability": "shell:system-scoped",
            "target": "service:valkhana-core",
            "risk": "critical",
            "correlation_id": "correlation-approval"
        });
        let pending = app
            .clone()
            .oneshot(
                Request::post("/v1/policy/decisions")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(request_body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(pending.status(), StatusCode::ACCEPTED);
        let value: Value =
            serde_json::from_slice(&to_bytes(pending.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(value["decision"]["decision"], "require_human_approval");
        let approval_id = value["decision"]["approval_id"]
            .as_str()
            .unwrap()
            .to_owned();

        let approval = app
            .clone()
            .oneshot(
                Request::get(format!("/v1/policy/approvals/{approval_id}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(approval.status(), StatusCode::OK);
        let value: Value =
            serde_json::from_slice(&to_bytes(approval.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(value["approval"]["status"], "pending");

        let approvals = app
            .clone()
            .oneshot(
                Request::get("/v1/policy/approvals?limit=1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let value: Value =
            serde_json::from_slice(&to_bytes(approvals.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(value["approvals"][0]["status"], "pending");

        let mutation = app
            .oneshot(
                Request::patch(format!("/v1/policy/approvals/{approval_id}"))
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(mutation.status(), StatusCode::METHOD_NOT_ALLOWED);
    }

    #[tokio::test]
    async fn low_risk_unconfigured_policy_capability_is_forbidden_and_audited() {
        let state_root = tempfile::tempdir().unwrap();
        let policy = PolicyService::new(
            PolicyConfiguration::default(),
            PolicyLedger::open(state_root.path()).unwrap(),
        );
        let app = app_with_runtime(HermesAdapter::from_env().unwrap(), None, Some(policy));
        let denied = app
            .clone()
            .oneshot(
                Request::post("/v1/policy/decisions")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({
                            "principal": "agent:builder",
                            "task_id": "task-1",
                            "project_id": "valkhana",
                            "capability": "network:production",
                            "target": "api.example.test",
                            "risk": "low"
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(denied.status(), StatusCode::FORBIDDEN);
        let value: Value =
            serde_json::from_slice(&to_bytes(denied.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(value["decision"]["decision"], "deny");

        let recent = app
            .oneshot(
                Request::get("/v1/policy/decisions?limit=1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let value: Value =
            serde_json::from_slice(&to_bytes(recent.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(value["decisions"][0]["decision"], "deny");
    }

    #[tokio::test]
    async fn hermes_health_is_projected_without_becoming_task_authority() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 256];
            let read = stream.read(&mut request).await.unwrap();
            assert!(String::from_utf8_lossy(&request[..read]).starts_with("GET /health "));
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{\"status\":\"ok\",\"version\":\"test\"}",
                )
                .await
                .unwrap();
        });
        let endpoint = HermesGatewayEndpoint::parse(&format!("http://127.0.0.1:{port}")).unwrap();
        let response = app_with_hermes(endpoint)
            .oneshot(
                Request::get("/v1/integrations/hermes/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let value: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["name"], "hermes");
        assert_eq!(value["status"], "incompatible");
        assert_eq!(value["payload"]["version"], "test");
    }

    #[tokio::test]
    async fn hermes_boards_are_a_read_only_typed_projection() {
        let directory = tempfile::tempdir().unwrap();
        let cli = directory.path().join("hermes");
        std::fs::write(
            &cli,
            "#!/bin/sh\nif [ \"$1\" = --version ]; then printf 'Hermes Agent v0.20.2 (test)\\n'; else printf '%s\\n' '[{\"slug\":\"default\",\"name\":\"Default\",\"is_current\":true,\"counts\":{},\"total\":0}]'; fi\n",
        )
        .unwrap();
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o700)).unwrap();
        let adapter = HermesAdapter::Cli(valkhana_hermes::HermesCli::new(cli).unwrap());

        let response = app_with_adapter(adapter)
            .oneshot(
                Request::get("/v1/integrations/hermes/boards")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let value: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["boards"][0]["slug"], "default");
        assert_eq!(value["boards"][0]["is_current"], true);
        assert_eq!(value["boards"][0]["total"], 0);
    }

    #[tokio::test]
    async fn hermes_tasks_require_a_board_and_project_typed_status() {
        let directory = tempfile::tempdir().unwrap();
        let cli = directory.path().join("hermes");
        std::fs::write(
            &cli,
            "#!/bin/sh\nif [ \"$1\" = --version ]; then printf 'Hermes Agent v0.20.2 (test)\\n'; else printf '%s\\n' '[{\"id\":\"t_1\",\"title\":\"Build\",\"body\":null,\"assignee\":null,\"status\":\"ready\",\"priority\":0,\"workspace_kind\":\"scratch\",\"workspace_path\":null,\"branch_name\":null,\"created_by\":\"codex\",\"created_at\":1,\"started_at\":null,\"completed_at\":null,\"result\":null,\"skills\":[],\"max_retries\":null,\"model_override\":null,\"provider_override\":null,\"session_id\":null}]'; fi\n",
        )
        .unwrap();
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o700)).unwrap();
        let app = app_with_adapter(HermesAdapter::Cli(
            valkhana_hermes::HermesCli::new(cli).unwrap(),
        ));

        let missing = app
            .clone()
            .oneshot(
                Request::get("/v1/integrations/hermes/tasks")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(missing.status(), StatusCode::BAD_REQUEST);

        let response = app
            .oneshot(
                Request::get("/v1/integrations/hermes/tasks?board=project-one")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let value: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["board"], "project-one");
        assert_eq!(value["tasks"][0]["id"], "t_1");
        assert_eq!(value["tasks"][0]["status"], "ready");
    }

    #[tokio::test]
    async fn configured_project_mapping_supplies_the_board_deterministically() {
        let directory = tempfile::tempdir().unwrap();
        let cli = directory.path().join("hermes");
        std::fs::write(
            &cli,
            "#!/bin/sh\nif [ \"$1\" = --version ]; then printf 'Hermes Agent v0.20.2 (test)\\n'; else test \"$3\" = mapped-board && printf '[]\\n'; fi\n",
        )
        .unwrap();
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o700)).unwrap();
        let project = ProjectMapping {
            id: "mapped-project".into(),
            hermes_board: "mapped-board".into(),
            repo: "/projects/mapped".into(),
            default_workspace: valkhana_config::ProjectWorkspace::Worktree,
        };
        let state_root = tempfile::tempdir().unwrap();
        let app = app_with_runtime(
            HermesAdapter::Cli(valkhana_hermes::HermesCli::new(cli).unwrap()),
            Some(project),
            Some(PolicyService::new(
                PolicyConfiguration::default(),
                PolicyLedger::open(state_root.path()).unwrap(),
            )),
        );

        let response = app
            .oneshot(
                Request::get("/v1/integrations/hermes/tasks")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let value: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["board"], "mapped-board");
        assert_eq!(value["tasks"], json!([]));
    }

    #[tokio::test]
    async fn task_creation_is_idempotent_triage_on_the_configured_board() {
        let directory = tempfile::tempdir().unwrap();
        let cli = directory.path().join("hermes");
        std::fs::write(
            &cli,
            "#!/bin/sh\nif [ \"$1\" = --version ]; then printf 'Hermes Agent v0.20.2 (test)\\n'; else test \"$3\" = mapped-board && test \"$4\" = create && test \"${10}\" = --triage && printf '%s\\n' '{\"id\":\"t_new\",\"title\":\"Build\",\"body\":\"Details\",\"assignee\":null,\"status\":\"triage\",\"priority\":0,\"workspace_kind\":\"worktree\",\"workspace_path\":null,\"branch_name\":null,\"created_by\":\"valkhana\",\"created_at\":1,\"started_at\":null,\"completed_at\":null,\"result\":null,\"skills\":[],\"max_retries\":null,\"model_override\":null,\"provider_override\":null,\"session_id\":null}'; fi\n",
        )
        .unwrap();
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o700)).unwrap();
        let adapter = HermesAdapter::Cli(valkhana_hermes::HermesCli::new(cli).unwrap());
        let request = Request::post("/v1/integrations/hermes/tasks")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                r#"{"title":"Build","description":"Details","idempotency_key":"request-1"}"#,
            ))
            .unwrap();

        let unavailable = app_with_adapter(adapter.clone())
            .oneshot(request)
            .await
            .unwrap();
        assert_eq!(unavailable.status(), StatusCode::PRECONDITION_FAILED);

        let project = ProjectMapping {
            id: "mapped-project".into(),
            hermes_board: "mapped-board".into(),
            repo: "/projects/mapped".into(),
            default_workspace: ProjectWorkspace::Worktree,
        };
        let no_policy = app_with_config(adapter.clone(), Some(project.clone()))
            .oneshot(
                Request::post("/v1/integrations/hermes/tasks")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        r#"{"title":"Build","description":"Details","idempotency_key":"request-1"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(no_policy.status(), StatusCode::SERVICE_UNAVAILABLE);

        let state_root = tempfile::tempdir().unwrap();
        let policy = PolicyService::new(
            PolicyConfiguration::default(),
            PolicyLedger::open(state_root.path()).unwrap(),
        );
        let app = app_with_runtime(adapter, Some(project), Some(policy));
        let response = app
            .clone()
            .oneshot(
                Request::post("/v1/integrations/hermes/tasks")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        r#"{"title":"Build","description":"Details","idempotency_key":"request-1"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let value: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["task"]["id"], "t_new");
        assert_eq!(value["task"]["status"], "triage");
        assert_eq!(value["task"]["workspace_kind"], "worktree");

        let audit = app
            .oneshot(
                Request::get("/v1/policy/decisions?limit=1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let value: Value =
            serde_json::from_slice(&to_bytes(audit.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(value["decisions"][0]["principal"], "service:valkhana");
        assert_eq!(
            value["decisions"][0]["capability"],
            "hermes:task-admit-triage"
        );
        assert_eq!(value["decisions"][0]["decision"], "allow");
        assert_eq!(value["decisions"][0]["correlation_id"], "request-1");
    }

    #[tokio::test]
    async fn task_detail_and_manual_lifecycle_use_the_configured_board() {
        let directory = tempfile::tempdir().unwrap();
        let cli = directory.path().join("hermes");
        std::fs::write(
            &cli,
            r#"#!/bin/sh
if [ "$1" = --version ]; then printf 'Hermes Agent v0.20.2 (test)\n'; exit 0; fi
test "$1" = kanban && test "$2" = --board && test "$3" = mapped-board
STATE="$0.state"
case "$4" in
  show)
    STATUS=ready; test -f "$STATE" && STATUS=$(cat "$STATE")
    printf '{"task":{"id":"t_123","title":"Build","body":null,"assignee":null,"status":"%s","priority":0,"workspace_kind":"worktree","workspace_path":null,"branch_name":null,"created_by":"valkhana","created_at":1,"started_at":null,"completed_at":null,"result":null,"skills":[],"max_retries":null,"model_override":null,"provider_override":null,"session_id":null}}\n' "$STATUS"
    ;;
  block) test "$5" = --kind && test "$6" = needs_input && test "$7" = t_123; printf blocked > "$STATE" ;;
  request-review) test "$5" = --summary && test "$7" = t_123; printf review > "$STATE" ;;
  complete) test "$5" = --result && test "$6" = finished && test "$7" = t_123; printf done > "$STATE" ;;
  archive) test "$5" = t_123; printf archived > "$STATE" ;;
  *) exit 2 ;;
esac
"#,
        )
        .unwrap();
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o700)).unwrap();
        let project = ProjectMapping {
            id: "mapped-project".into(),
            hermes_board: "mapped-board".into(),
            repo: "/projects/mapped".into(),
            default_workspace: ProjectWorkspace::Worktree,
        };
        let state_root = tempfile::tempdir().unwrap();
        let dashboard_key = vec![31; 32];
        let app = app_with_services(
            HermesAdapter::Cli(valkhana_hermes::HermesCli::new(cli).unwrap()),
            Some(project),
            Some(PolicyService::new(
                PolicyConfiguration::default(),
                PolicyLedger::open(state_root.path()).unwrap(),
            )),
            Some(Arc::new(FixedSecretStore(dashboard_key.clone()))),
        );

        let detail = app
            .clone()
            .oneshot(
                Request::get("/v1/integrations/hermes/tasks/t_123")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(detail.status(), StatusCode::OK);

        let blocked = app
            .clone()
            .oneshot(
                Request::patch("/v1/integrations/hermes/tasks/t_123")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"action":"block","reason":"needs input"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(blocked.status(), StatusCode::OK);

        let audit = app
            .clone()
            .oneshot(
                Request::get("/v1/policy/decisions?limit=1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let value: Value =
            serde_json::from_slice(&to_bytes(audit.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(
            value["decisions"][0]["capability"],
            "hermes:task-block-needs-input"
        );
        assert_eq!(value["decisions"][0]["decision"], "allow");
        let body = to_bytes(blocked.into_body(), usize::MAX).await.unwrap();
        let value: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["task"]["status"], "blocked");

        let review = app
            .clone()
            .oneshot(
                Request::patch("/v1/integrations/hermes/tasks/t_123")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        r#"{"action":"request_review","summary":"ready for review"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(review.status(), StatusCode::OK);
        let body = to_bytes(review.into_body(), usize::MAX).await.unwrap();
        let value: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["task"]["status"], "review");

        let audit = app
            .clone()
            .oneshot(
                Request::get("/v1/policy/decisions?limit=1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let value: Value =
            serde_json::from_slice(&to_bytes(audit.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(
            value["decisions"][0]["capability"],
            "hermes:task-request-review"
        );

        let now = unix_time_ms().unwrap();
        let wrong_payload = app
            .clone()
            .oneshot(signed_request(
                &dashboard_key,
                SignedRequestInput {
                    method: Method::PATCH,
                    path: "/v1/integrations/hermes/tasks/t_123",
                    action: "complete",
                    payload: b"different",
                    timestamp: now,
                    nonce: "00000000000000000000000000000000",
                    body: Body::from(r#"{"action":"complete","result":"finished"}"#),
                },
            ))
            .await
            .unwrap();
        assert_eq!(wrong_payload.status(), StatusCode::UNAUTHORIZED);

        let complete_nonce = "00000000000000000000000000000001";
        let completed = app
            .clone()
            .oneshot(signed_request(
                &dashboard_key,
                SignedRequestInput {
                    method: Method::PATCH,
                    path: "/v1/integrations/hermes/tasks/t_123",
                    action: "complete",
                    payload: b"finished",
                    timestamp: now,
                    nonce: complete_nonce,
                    body: Body::from(r#"{"action":"complete","result":"finished"}"#),
                },
            ))
            .await
            .unwrap();
        assert_eq!(completed.status(), StatusCode::OK);
        let body = to_bytes(completed.into_body(), usize::MAX).await.unwrap();
        let value: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["task"]["status"], "done");

        let complete_replay = app
            .clone()
            .oneshot(signed_request(
                &dashboard_key,
                SignedRequestInput {
                    method: Method::PATCH,
                    path: "/v1/integrations/hermes/tasks/t_123",
                    action: "complete",
                    payload: b"finished",
                    timestamp: now,
                    nonce: complete_nonce,
                    body: Body::from(r#"{"action":"complete","result":"finished"}"#),
                },
            ))
            .await
            .unwrap();
        assert_eq!(complete_replay.status(), StatusCode::UNAUTHORIZED);

        let missing_proof = app
            .clone()
            .oneshot(
                Request::delete("/v1/integrations/hermes/tasks/t_123")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(missing_proof.status(), StatusCode::UNAUTHORIZED);

        let wrong_proof = app
            .clone()
            .oneshot(signed_request(
                &[32; 32],
                SignedRequestInput {
                    method: Method::DELETE,
                    path: "/v1/integrations/hermes/tasks/t_123",
                    action: "archive",
                    payload: b"",
                    timestamp: now,
                    nonce: "00000000000000000000000000000001",
                    body: Body::empty(),
                },
            ))
            .await
            .unwrap();
        assert_eq!(wrong_proof.status(), StatusCode::UNAUTHORIZED);

        let stale_proof = app
            .clone()
            .oneshot(signed_request(
                &dashboard_key,
                SignedRequestInput {
                    method: Method::DELETE,
                    path: "/v1/integrations/hermes/tasks/t_123",
                    action: "archive",
                    payload: b"",
                    timestamp: now - SERVICE_REQUEST_WINDOW_MS - 1,
                    nonce: "00000000000000000000000000000002",
                    body: Body::empty(),
                },
            ))
            .await
            .unwrap();
        assert_eq!(stale_proof.status(), StatusCode::UNAUTHORIZED);

        let valid_nonce = "00000000000000000000000000000003";
        let archived = app
            .clone()
            .oneshot(signed_request(
                &dashboard_key,
                SignedRequestInput {
                    method: Method::DELETE,
                    path: "/v1/integrations/hermes/tasks/t_123",
                    action: "archive",
                    payload: b"",
                    timestamp: now,
                    nonce: valid_nonce,
                    body: Body::empty(),
                },
            ))
            .await
            .unwrap();
        assert_eq!(archived.status(), StatusCode::OK);
        let body = to_bytes(archived.into_body(), usize::MAX).await.unwrap();
        let value: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["task"]["status"], "archived");

        let replay = app
            .oneshot(signed_request(
                &dashboard_key,
                SignedRequestInput {
                    method: Method::DELETE,
                    path: "/v1/integrations/hermes/tasks/t_123",
                    action: "archive",
                    payload: b"",
                    timestamp: now,
                    nonce: valid_nonce,
                    body: Body::empty(),
                },
            ))
            .await
            .unwrap();
        assert_eq!(replay.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn protected_assignment_is_deduplicated_and_executes_only_after_exact_approval() {
        let directory = tempfile::tempdir().unwrap();
        let cli = directory.path().join("hermes");
        std::fs::write(
            &cli,
            r#"#!/bin/sh
if [ "$1" = --version ]; then printf 'Hermes Agent v0.20.2 (test)\n'; exit 0; fi
test "$1" = kanban && test "$2" = --board && test "$3" = mapped-board
STATE="$0.state"
case "$4" in
  assign) test "$5" = t_123 && test "$6" = builder; printf assigned > "$STATE" ;;
  show)
    ASSIGNEE=null; test -f "$STATE" && ASSIGNEE='"builder"'
    printf '{"task":{"id":"t_123","title":"Build","body":null,"assignee":%s,"status":"ready","priority":0,"workspace_kind":"worktree","workspace_path":null,"branch_name":null,"created_by":"valkhana","created_at":1,"started_at":null,"completed_at":null,"result":null,"skills":[],"max_retries":null,"model_override":null,"provider_override":null,"session_id":null}}\n' "$ASSIGNEE"
    ;;
  *) exit 2 ;;
esac
"#,
        )
        .unwrap();
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o700)).unwrap();
        let project = ProjectMapping {
            id: "mapped-project".into(),
            hermes_board: "mapped-board".into(),
            repo: "/projects/mapped".into(),
            default_workspace: ProjectWorkspace::Worktree,
        };
        let state_root = tempfile::tempdir().unwrap();
        let policy = PolicyService::new(
            PolicyConfiguration::default(),
            PolicyLedger::open(state_root.path()).unwrap(),
        );
        let dashboard_key = vec![41; 32];
        let app = app_with_services(
            HermesAdapter::Cli(valkhana_hermes::HermesCli::new(&cli).unwrap()),
            Some(project),
            Some(policy.clone()),
            Some(Arc::new(FixedSecretStore(dashboard_key.clone()))),
        );
        let path = "/v1/integrations/hermes/tasks/t_123";
        let body = r#"{"action":"assign","profile":"builder"}"#;
        let now = unix_time_ms().unwrap();

        let pending = app
            .clone()
            .oneshot(signed_request(
                &dashboard_key,
                SignedRequestInput {
                    method: Method::PATCH,
                    path,
                    action: "assign",
                    payload: b"builder",
                    timestamp: now,
                    nonce: "10000000000000000000000000000001",
                    body: Body::from(body),
                },
            ))
            .await
            .unwrap();
        assert_eq!(pending.status(), StatusCode::ACCEPTED);
        assert!(!cli.with_extension("state").exists());
        let value: Value =
            serde_json::from_slice(&to_bytes(pending.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        let approval_id = value["decision"]["approval_id"]
            .as_str()
            .unwrap()
            .to_owned();

        let duplicate = app
            .clone()
            .oneshot(signed_request(
                &dashboard_key,
                SignedRequestInput {
                    method: Method::PATCH,
                    path,
                    action: "assign",
                    payload: b"builder",
                    timestamp: now,
                    nonce: "10000000000000000000000000000002",
                    body: Body::from(body),
                },
            ))
            .await
            .unwrap();
        let value: Value =
            serde_json::from_slice(&to_bytes(duplicate.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(value["decision"]["approval_id"], approval_id);

        policy
            .transition_approval(
                &approval_id,
                &ApprovalAction::Approve {
                    expires_in_ms: 60_000,
                },
                "human:operator",
                "approved assignment",
            )
            .unwrap();
        let executed = app
            .oneshot(signed_request(
                &dashboard_key,
                SignedRequestInput {
                    method: Method::PATCH,
                    path,
                    action: "assign",
                    payload: b"builder",
                    timestamp: unix_time_ms().unwrap(),
                    nonce: "10000000000000000000000000000003",
                    body: Body::from(body),
                },
            ))
            .await
            .unwrap();
        assert_eq!(executed.status(), StatusCode::OK);
        let value: Value =
            serde_json::from_slice(&to_bytes(executed.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(value["task"]["assignee"], "builder");
    }
}
