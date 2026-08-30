//! Rust-owned Policy Decision Point contracts.
//!
//! This crate decides policy; enforcement and action execution belong to PEPs.

use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result, bail};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use valkhana_config::{ConfigKind, ConfigSet};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PolicyDecision {
    Allow,
    Deny,
    RequireHumanApproval,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RiskClass {
    Low,
    Medium,
    High,
    Critical,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PermissionProfile {
    Observe,
    WorkspaceLite,
    Workspace,
    Research,
    Trusted,
    System,
    Admin,
}

impl PermissionProfile {
    pub const fn baseline_capabilities(self) -> &'static [&'static str] {
        match self {
            Self::Observe => &["project:read", "task:read"],
            Self::WorkspaceLite => &[
                "project:read",
                "task:read",
                "task-artifacts:read-write",
                "shell:safe-read-only",
            ],
            Self::Workspace => &[
                "project:read-write",
                "worktree:read-write",
                "shell:workspace",
                "git:task-branch-write",
                "docker:project-only",
            ],
            Self::Research => &[
                "project:read",
                "task-artifacts:read-write",
                "shell:diagnostic",
                "network:research-allowlist",
                "docker:inspect-only",
                "system-services:inspect-only",
            ],
            Self::Trusted => &[
                "project:read-write",
                "worktree:read-write",
                "shell:workspace",
                "git:task-branch-write",
                "docker:selected-project",
                "system-services:inspect",
            ],
            Self::System => &[
                "shell:system-scoped",
                "network:allowlist",
                "git:as-needed",
                "docker:selected",
            ],
            Self::Admin => &[],
        }
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentPolicy {
    pub profile: PermissionProfile,
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub filesystem: Option<yaml_serde::Value>,
    #[serde(default)]
    pub shell: Option<yaml_serde::Value>,
    #[serde(default)]
    pub network: Option<yaml_serde::Value>,
    #[serde(default)]
    pub git_write: Option<yaml_serde::Value>,
    #[serde(default)]
    pub docker: Option<yaml_serde::Value>,
    #[serde(default)]
    pub system_services: Option<yaml_serde::Value>,
    #[serde(default)]
    pub package_manager: Option<yaml_serde::Value>,
    #[serde(default)]
    pub sudo: Option<yaml_serde::Value>,
    #[serde(default)]
    pub secrets: Option<yaml_serde::Value>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct PolicyConfiguration {
    agents: BTreeMap<String, AgentPolicy>,
}

impl PolicyConfiguration {
    pub fn from_config(config: &ConfigSet) -> Result<Self> {
        let Some(document) = config.get(ConfigKind::Permissions) else {
            return Ok(Self::default());
        };
        let agents = match document.values.get("agents") {
            Some(value) => yaml_serde::from_value::<BTreeMap<String, AgentPolicy>>(value.clone())
                .context("invalid agents mapping in permissions.yaml")?,
            None => BTreeMap::new(),
        };
        for (principal, policy) in &agents {
            if !valid_identifier(principal) {
                bail!("invalid agent principal {principal:?} in permissions.yaml");
            }
            if policy.profile == PermissionProfile::Admin {
                bail!(
                    "agent {principal:?} cannot persistently use admin; grant it explicitly with expiry"
                );
            }
            for capability in &policy.capabilities {
                if !valid_identifier(capability) {
                    bail!("agent {principal:?} has invalid capability {capability:?}");
                }
            }
        }
        Ok(Self { agents })
    }

    pub fn agent(&self, principal: &str) -> Option<&AgentPolicy> {
        self.agents.get(principal)
    }

    pub fn agent_count(&self) -> usize {
        self.agents.len()
    }

    pub fn baseline_allows(&self, principal: &str, capability: &str) -> bool {
        if principal == "service:valkhana"
            && matches!(
                capability,
                "hermes:task-admit-triage"
                    | "hermes:task-block-needs-input"
                    | "hermes:task-request-review"
            )
        {
            return true;
        }
        self.agent(principal).is_some_and(|policy| {
            policy.profile.baseline_capabilities().contains(&capability)
                || policy
                    .capabilities
                    .iter()
                    .any(|configured| configured == capability)
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PolicyRequest<'a> {
    pub principal: &'a str,
    pub task_id: Option<&'a str>,
    pub project_id: Option<&'a str>,
    pub capability: &'a str,
    pub target: &'a str,
    pub risk: RiskClass,
    pub baseline_capabilities: &'a [&'a str],
    pub active_grant: Option<&'a CapabilityGrant>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapabilityGrant {
    pub principal: String,
    pub task_id: String,
    pub project_id: String,
    pub capability: String,
    pub target: String,
    pub expires_at_unix_ms: u64,
    pub approval_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PolicyDecisionRecord {
    pub decision_id: String,
    pub timestamp_unix_ms: u64,
    pub principal: String,
    pub task_id: Option<String>,
    pub project_id: Option<String>,
    pub capability: String,
    pub target: String,
    pub risk: RiskClass,
    pub decision: PolicyDecision,
    pub approval_id: Option<String>,
    pub result: Option<String>,
    pub correlation_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PolicyEvaluationInput {
    pub principal: String,
    pub task_id: Option<String>,
    pub project_id: Option<String>,
    pub capability: String,
    pub target: String,
    pub risk: RiskClass,
    pub correlation_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PolicyAuthorization {
    Authorized(PolicyDecisionRecord),
    Denied(PolicyDecisionRecord),
    ApprovalRequired(PolicyDecisionRecord),
}

impl PolicyAuthorization {
    pub fn record(&self) -> &PolicyDecisionRecord {
        match self {
            Self::Authorized(record) | Self::Denied(record) | Self::ApprovalRequired(record) => {
                record
            }
        }
    }

    pub fn into_record(self) -> PolicyDecisionRecord {
        match self {
            Self::Authorized(record) | Self::Denied(record) | Self::ApprovalRequired(record) => {
                record
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalStatus {
    Pending,
    Approved,
    Denied,
    Expired,
    Revoked,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ApprovalRecord {
    pub approval_id: String,
    pub decision_id: String,
    pub status: ApprovalStatus,
    pub principal: String,
    pub task_id: String,
    pub project_id: String,
    pub capability: String,
    pub target: String,
    pub risk: RiskClass,
    pub created_at_unix_ms: u64,
    pub expires_at_unix_ms: u64,
    pub decided_at_unix_ms: Option<u64>,
    pub decided_by: Option<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum ApprovalAction {
    Approve { expires_in_ms: u64 },
    Deny,
    Revoke,
}

#[derive(Debug, Clone)]
pub struct PolicyLedger {
    path: PathBuf,
}

impl PolicyLedger {
    pub fn open(state_dir: &Path) -> Result<Self> {
        if !state_dir.is_absolute() {
            bail!("ValKhana state directory must be absolute");
        }
        let policy_dir = state_dir.join("policy");
        fs::create_dir_all(&policy_dir)
            .with_context(|| format!("failed to create {}", policy_dir.display()))?;
        fs::set_permissions(&policy_dir, fs::Permissions::from_mode(0o700))?;
        let path = policy_dir.join("decisions.db");
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .mode(0o600)
            .open(&path)
            .with_context(|| format!("failed to create {}", path.display()))?;
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
        drop(file);
        let ledger = Self { path };
        ledger.initialize()?;
        Ok(ledger)
    }

    pub fn append(&self, record: &PolicyDecisionRecord) -> Result<()> {
        validate_record(record)?;
        let connection = self.connection()?;
        insert_decision(&connection, record).context("failed to append policy decision")
    }

    pub fn get(&self, decision_id: &str) -> Result<Option<PolicyDecisionRecord>> {
        validate_identifier("decision_id", decision_id, 200)?;
        let connection = self.connection()?;
        connection
            .query_row(
                "SELECT decision_id, timestamp_unix_ms, principal, task_id, project_id,
                        capability, target, risk, decision, approval_id, result, correlation_id
                 FROM decisions WHERE decision_id = ?1",
                [decision_id],
                row_to_record,
            )
            .optional()
            .context("failed to query policy decision")
    }

    pub fn recent(&self, limit: usize) -> Result<Vec<PolicyDecisionRecord>> {
        let limit = i64::try_from(limit.clamp(1, 500)).expect("bounded limit fits i64");
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT decision_id, timestamp_unix_ms, principal, task_id, project_id,
                    capability, target, risk, decision, approval_id, result, correlation_id
             FROM decisions ORDER BY timestamp_unix_ms DESC, decision_id DESC LIMIT ?1",
        )?;
        let rows = statement.query_map([limit], row_to_record)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("failed to query recent policy decisions")
    }

    pub fn approval(&self, approval_id: &str, now_unix_ms: u64) -> Result<Option<ApprovalRecord>> {
        validate_identifier("approval_id", approval_id, 200)?;
        self.expire_approvals(now_unix_ms)?;
        let connection = self.connection()?;
        connection
            .query_row(
                "SELECT approval_id, decision_id, status, principal, task_id, project_id,
                        capability, target, risk, created_at_unix_ms, expires_at_unix_ms,
                        decided_at_unix_ms, decided_by, reason
                 FROM approvals WHERE approval_id = ?1",
                [approval_id],
                row_to_approval,
            )
            .optional()
            .context("failed to query policy approval")
    }

    pub fn recent_approvals(&self, limit: usize, now_unix_ms: u64) -> Result<Vec<ApprovalRecord>> {
        self.expire_approvals(now_unix_ms)?;
        let limit = i64::try_from(limit.clamp(1, 500)).expect("bounded limit fits i64");
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT approval_id, decision_id, status, principal, task_id, project_id,
                    capability, target, risk, created_at_unix_ms, expires_at_unix_ms,
                    decided_at_unix_ms, decided_by, reason
             FROM approvals ORDER BY created_at_unix_ms DESC, approval_id DESC LIMIT ?1",
        )?;
        let rows = statement.query_map([limit], row_to_approval)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("failed to query recent policy approvals")
    }

    fn append_with_approval(
        &self,
        record: &PolicyDecisionRecord,
        approval: &ApprovalRecord,
    ) -> Result<()> {
        validate_record(record)?;
        validate_approval(approval)?;
        if record.approval_id.as_deref() != Some(approval.approval_id.as_str())
            || record.decision_id != approval.decision_id
            || record.decision != PolicyDecision::RequireHumanApproval
        {
            bail!("policy decision and approval linkage do not match");
        }
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        insert_decision(&transaction, record)?;
        transaction.execute(
            "INSERT INTO approvals (
                approval_id, decision_id, status, principal, task_id, project_id,
                capability, target, risk, created_at_unix_ms, expires_at_unix_ms,
                decided_at_unix_ms, decided_by, reason
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, NULL, NULL, NULL)",
            params![
                approval.approval_id,
                approval.decision_id,
                approval_status_name(approval.status),
                approval.principal,
                approval.task_id,
                approval.project_id,
                approval.capability,
                approval.target,
                risk_name(approval.risk),
                i64::try_from(approval.created_at_unix_ms)?,
                i64::try_from(approval.expires_at_unix_ms)?,
            ],
        )?;
        transaction.commit()?;
        Ok(())
    }

    fn active_grant(
        &self,
        input: &PolicyEvaluationInput,
        now_unix_ms: u64,
    ) -> Result<Option<CapabilityGrant>> {
        let (Some(task_id), Some(project_id)) = (&input.task_id, &input.project_id) else {
            return Ok(None);
        };
        self.expire_approvals(now_unix_ms)?;
        let now = i64::try_from(now_unix_ms)?;
        let connection = self.connection()?;
        connection
            .query_row(
                "SELECT approval_id, principal, task_id, project_id, capability, target,
                        expires_at_unix_ms
                 FROM approvals
                 WHERE status = 'approved' AND expires_at_unix_ms > ?1
                   AND principal = ?2 AND task_id = ?3 AND project_id = ?4
                   AND capability = ?5 AND target = ?6
                 ORDER BY expires_at_unix_ms DESC LIMIT 1",
                params![
                    now,
                    input.principal,
                    task_id,
                    project_id,
                    input.capability,
                    input.target,
                ],
                |row| {
                    let expires: i64 = row.get(6)?;
                    Ok(CapabilityGrant {
                        approval_id: row.get(0)?,
                        principal: row.get(1)?,
                        task_id: row.get(2)?,
                        project_id: row.get(3)?,
                        capability: row.get(4)?,
                        target: row.get(5)?,
                        expires_at_unix_ms: u64::try_from(expires).map_err(|error| {
                            rusqlite::Error::FromSqlConversionFailure(
                                6,
                                rusqlite::types::Type::Integer,
                                Box::new(error),
                            )
                        })?,
                    })
                },
            )
            .optional()
            .context("failed to resolve active policy grant")
    }

    fn pending_approval_id(
        &self,
        input: &PolicyEvaluationInput,
        now_unix_ms: u64,
    ) -> Result<Option<String>> {
        let (Some(task_id), Some(project_id)) = (&input.task_id, &input.project_id) else {
            return Ok(None);
        };
        self.expire_approvals(now_unix_ms)?;
        let connection = self.connection()?;
        connection
            .query_row(
                "SELECT approval_id FROM approvals
                 WHERE status = 'pending' AND expires_at_unix_ms > ?1
                   AND principal = ?2 AND task_id = ?3 AND project_id = ?4
                   AND capability = ?5 AND target = ?6
                 ORDER BY created_at_unix_ms DESC LIMIT 1",
                params![
                    i64::try_from(now_unix_ms)?,
                    input.principal,
                    task_id,
                    project_id,
                    input.capability,
                    input.target,
                ],
                |row| row.get(0),
            )
            .optional()
            .context("failed to resolve pending policy approval")
    }

    fn transition_approval(
        &self,
        approval_id: &str,
        action: &ApprovalAction,
        actor: &str,
        reason: &str,
        now_unix_ms: u64,
    ) -> Result<ApprovalRecord> {
        validate_identifier("approval_id", approval_id, 200)?;
        validate_identifier("approval actor", actor, 200)?;
        if !actor.starts_with("human:") {
            bail!("policy approval transitions require a human principal");
        }
        validate_text("approval reason", reason, 4096)?;
        self.expire_approvals(now_unix_ms)?;
        let now = i64::try_from(now_unix_ms)?;
        let connection = self.connection()?;
        let changed = match action {
            ApprovalAction::Approve { expires_in_ms } => {
                if *expires_in_ms == 0 || *expires_in_ms > 86_400_000 {
                    bail!("approved elevation must expire within 24 hours");
                }
                let expires = now_unix_ms
                    .checked_add(*expires_in_ms)
                    .context("approval expiry timestamp overflow")?;
                connection.execute(
                    "UPDATE approvals SET status = 'approved', expires_at_unix_ms = ?1,
                        decided_at_unix_ms = ?2, decided_by = ?3, reason = ?4
                     WHERE approval_id = ?5 AND status = 'pending'",
                    params![i64::try_from(expires)?, now, actor, reason, approval_id],
                )?
            }
            ApprovalAction::Deny => connection.execute(
                "UPDATE approvals SET status = 'denied', decided_at_unix_ms = ?1,
                    decided_by = ?2, reason = ?3
                 WHERE approval_id = ?4 AND status = 'pending'",
                params![now, actor, reason, approval_id],
            )?,
            ApprovalAction::Revoke => connection.execute(
                "UPDATE approvals SET status = 'revoked', decided_at_unix_ms = ?1,
                    decided_by = ?2, reason = ?3
                 WHERE approval_id = ?4 AND status = 'approved'",
                params![now, actor, reason, approval_id],
            )?,
        };
        if changed != 1 {
            bail!("approval is missing, expired, or not valid for this transition");
        }
        drop(connection);
        self.approval(approval_id, now_unix_ms)?
            .context("approval disappeared after transition")
    }

    fn expire_approvals(&self, now_unix_ms: u64) -> Result<()> {
        let connection = self.connection()?;
        connection.execute(
            "UPDATE approvals SET status = 'expired'
             WHERE status IN ('pending', 'approved') AND expires_at_unix_ms <= ?1",
            [i64::try_from(now_unix_ms)?],
        )?;
        Ok(())
    }

    fn initialize(&self) -> Result<()> {
        let connection = self.connection()?;
        connection.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA synchronous=FULL;
             CREATE TABLE IF NOT EXISTS ledger_metadata (
                 key TEXT PRIMARY KEY NOT NULL,
                 value TEXT NOT NULL
             ) STRICT;
             INSERT OR IGNORE INTO ledger_metadata(key, value) VALUES ('schema_version', '1');
             CREATE TABLE IF NOT EXISTS decisions (
                 decision_id TEXT PRIMARY KEY NOT NULL,
                 timestamp_unix_ms INTEGER NOT NULL CHECK(timestamp_unix_ms >= 0),
                 principal TEXT NOT NULL,
                 task_id TEXT,
                 project_id TEXT,
                 capability TEXT NOT NULL,
                 target TEXT NOT NULL,
                 risk TEXT NOT NULL CHECK(risk IN ('low','medium','high','critical')),
                 decision TEXT NOT NULL CHECK(decision IN ('allow','deny','require_human_approval')),
                 approval_id TEXT,
                 result TEXT,
                 correlation_id TEXT
             ) STRICT;
             CREATE INDEX IF NOT EXISTS decisions_timestamp_idx
                 ON decisions(timestamp_unix_ms DESC);
             CREATE TABLE IF NOT EXISTS approvals (
                 approval_id TEXT PRIMARY KEY NOT NULL,
                 decision_id TEXT UNIQUE NOT NULL,
                 status TEXT NOT NULL CHECK(status IN ('pending','approved','denied','expired','revoked')),
                 principal TEXT NOT NULL,
                 task_id TEXT NOT NULL,
                 project_id TEXT NOT NULL,
                 capability TEXT NOT NULL,
                 target TEXT NOT NULL,
                 risk TEXT NOT NULL CHECK(risk IN ('medium','high','critical')),
                 created_at_unix_ms INTEGER NOT NULL CHECK(created_at_unix_ms >= 0),
                 expires_at_unix_ms INTEGER NOT NULL CHECK(expires_at_unix_ms > created_at_unix_ms),
                 decided_at_unix_ms INTEGER,
                 decided_by TEXT,
                 reason TEXT,
                 FOREIGN KEY(decision_id) REFERENCES decisions(decision_id)
             ) STRICT;
             CREATE INDEX IF NOT EXISTS approvals_scope_idx
                 ON approvals(principal, task_id, project_id, capability, target, status, expires_at_unix_ms);"
        )?;
        let version: String = connection.query_row(
            "SELECT value FROM ledger_metadata WHERE key = 'schema_version'",
            [],
            |row| row.get(0),
        )?;
        if version != "1" {
            bail!("unsupported policy ledger schema_version {version}");
        }
        Ok(())
    }

    fn connection(&self) -> Result<Connection> {
        let connection = Connection::open(&self.path)
            .with_context(|| format!("failed to open {}", self.path.display()))?;
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        Ok(connection)
    }
}

fn insert_decision(connection: &Connection, record: &PolicyDecisionRecord) -> Result<()> {
    connection.execute(
        "INSERT INTO decisions (
            decision_id, timestamp_unix_ms, principal, task_id, project_id,
            capability, target, risk, decision, approval_id, result, correlation_id
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            record.decision_id,
            i64::try_from(record.timestamp_unix_ms)?,
            record.principal,
            record.task_id,
            record.project_id,
            record.capability,
            record.target,
            risk_name(record.risk),
            decision_name(record.decision),
            record.approval_id,
            record.result,
            record.correlation_id,
        ],
    )?;
    Ok(())
}

#[derive(Debug, Clone)]
pub struct PolicyService {
    configuration: PolicyConfiguration,
    engine: PolicyEngine,
    ledger: PolicyLedger,
    sequence: Arc<AtomicU64>,
}

impl PolicyService {
    pub fn new(configuration: PolicyConfiguration, ledger: PolicyLedger) -> Self {
        Self {
            configuration,
            engine: PolicyEngine,
            ledger,
            sequence: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn evaluate(&self, input: PolicyEvaluationInput) -> Result<PolicyDecisionRecord> {
        self.evaluate_at(input, unix_time_ms()?)
    }

    pub fn authorize(&self, input: PolicyEvaluationInput) -> Result<PolicyAuthorization> {
        self.authorize_at(input, unix_time_ms()?)
    }

    pub fn authorize_at(
        &self,
        input: PolicyEvaluationInput,
        timestamp_unix_ms: u64,
    ) -> Result<PolicyAuthorization> {
        let record = self.evaluate_at(input, timestamp_unix_ms)?;
        Ok(match record.decision {
            PolicyDecision::Allow => PolicyAuthorization::Authorized(record),
            PolicyDecision::Deny => PolicyAuthorization::Denied(record),
            PolicyDecision::RequireHumanApproval => PolicyAuthorization::ApprovalRequired(record),
        })
    }

    pub fn evaluate_at(
        &self,
        input: PolicyEvaluationInput,
        timestamp_unix_ms: u64,
    ) -> Result<PolicyDecisionRecord> {
        let baseline = [input.capability.as_str()];
        let baseline_capabilities: &[&str] = if self
            .configuration
            .baseline_allows(&input.principal, &input.capability)
        {
            &baseline
        } else {
            &[]
        };
        // Elevation is deliberately not accepted from this input. Only the server-owned
        // approval store can resolve a matching, unexpired grant.
        let active_grant = self.ledger.active_grant(&input, timestamp_unix_ms)?;
        let pending_approval_id = if active_grant.is_none() {
            self.ledger.pending_approval_id(&input, timestamp_unix_ms)?
        } else {
            None
        };
        let request = PolicyRequest {
            principal: &input.principal,
            task_id: input.task_id.as_deref(),
            project_id: input.project_id.as_deref(),
            capability: &input.capability,
            target: &input.target,
            risk: input.risk,
            baseline_capabilities,
            active_grant: active_grant.as_ref(),
        };
        let decision = self.engine.decide(&request, timestamp_unix_ms);
        let sequence = self.sequence.fetch_add(1, Ordering::Relaxed);
        let mut record = PolicyDecisionRecord {
            decision_id: format!(
                "decision-{timestamp_unix_ms}-{}-{sequence}",
                std::process::id()
            ),
            timestamp_unix_ms,
            principal: input.principal,
            task_id: input.task_id,
            project_id: input.project_id,
            capability: input.capability,
            target: input.target,
            risk: input.risk,
            decision,
            approval_id: active_grant.as_ref().map(|grant| grant.approval_id.clone()),
            result: Some(
                match decision {
                    PolicyDecision::Allow => "allowed by configured baseline",
                    PolicyDecision::Deny => "denied by policy",
                    PolicyDecision::RequireHumanApproval => "human approval required",
                }
                .to_owned(),
            ),
            correlation_id: input.correlation_id,
        };
        if decision == PolicyDecision::RequireHumanApproval {
            if let Some(approval_id) = pending_approval_id {
                record.approval_id = Some(approval_id);
                self.ledger.append(&record)?;
            } else if let (Some(task_id), Some(project_id)) = (&record.task_id, &record.project_id)
            {
                let approval_id = record.decision_id.replacen("decision-", "approval-", 1);
                record.approval_id = Some(approval_id.clone());
                let approval = ApprovalRecord {
                    approval_id,
                    decision_id: record.decision_id.clone(),
                    status: ApprovalStatus::Pending,
                    principal: record.principal.clone(),
                    task_id: task_id.clone(),
                    project_id: project_id.clone(),
                    capability: record.capability.clone(),
                    target: record.target.clone(),
                    risk: record.risk,
                    created_at_unix_ms: timestamp_unix_ms,
                    expires_at_unix_ms: timestamp_unix_ms
                        .checked_add(30 * 60 * 1000)
                        .context("pending approval expiry timestamp overflow")?,
                    decided_at_unix_ms: None,
                    decided_by: None,
                    reason: None,
                };
                self.ledger.append_with_approval(&record, &approval)?;
            } else {
                self.ledger.append(&record)?;
            }
        } else {
            self.ledger.append(&record)?;
        }
        Ok(record)
    }

    pub fn recent(&self, limit: usize) -> Result<Vec<PolicyDecisionRecord>> {
        self.ledger.recent(limit)
    }

    pub fn approval(&self, approval_id: &str) -> Result<Option<ApprovalRecord>> {
        self.ledger.approval(approval_id, unix_time_ms()?)
    }

    pub fn recent_approvals(&self, limit: usize) -> Result<Vec<ApprovalRecord>> {
        self.ledger.recent_approvals(limit, unix_time_ms()?)
    }

    pub fn transition_approval(
        &self,
        approval_id: &str,
        action: &ApprovalAction,
        actor: &str,
        reason: &str,
    ) -> Result<ApprovalRecord> {
        self.ledger
            .transition_approval(approval_id, action, actor, reason, unix_time_ms()?)
    }

    pub fn transition_approval_at(
        &self,
        approval_id: &str,
        action: &ApprovalAction,
        actor: &str,
        reason: &str,
        now_unix_ms: u64,
    ) -> Result<ApprovalRecord> {
        self.ledger
            .transition_approval(approval_id, action, actor, reason, now_unix_ms)
    }
}

fn unix_time_ms() -> Result<u64> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .context("system clock is before the Unix epoch")?;
    u64::try_from(now.as_millis())
        .context("system clock exceeds the supported policy timestamp range")
}

fn validate_record(record: &PolicyDecisionRecord) -> Result<()> {
    validate_identifier("decision_id", &record.decision_id, 200)?;
    validate_identifier("principal", &record.principal, 200)?;
    validate_identifier("capability", &record.capability, 200)?;
    validate_text("target", &record.target, 4096)?;
    for (name, value) in [
        ("task_id", record.task_id.as_deref()),
        ("project_id", record.project_id.as_deref()),
        ("approval_id", record.approval_id.as_deref()),
        ("correlation_id", record.correlation_id.as_deref()),
    ] {
        if let Some(value) = value {
            validate_identifier(name, value, 200)?;
        }
    }
    if let Some(result) = &record.result {
        validate_text("result", result, 16 * 1024)?;
    }
    Ok(())
}

fn validate_approval(approval: &ApprovalRecord) -> Result<()> {
    validate_identifier("approval_id", &approval.approval_id, 200)?;
    validate_identifier("decision_id", &approval.decision_id, 200)?;
    validate_identifier("principal", &approval.principal, 200)?;
    validate_identifier("task_id", &approval.task_id, 200)?;
    validate_identifier("project_id", &approval.project_id, 200)?;
    validate_identifier("capability", &approval.capability, 200)?;
    validate_text("target", &approval.target, 4096)?;
    if approval.status != ApprovalStatus::Pending
        || approval.risk == RiskClass::Low
        || approval.expires_at_unix_ms <= approval.created_at_unix_ms
        || approval.decided_at_unix_ms.is_some()
        || approval.decided_by.is_some()
        || approval.reason.is_some()
    {
        bail!("invalid pending policy approval");
    }
    Ok(())
}

fn validate_identifier(name: &str, value: &str, max: usize) -> Result<()> {
    if value.is_empty()
        || value.len() > max
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'_' | b'-' | b'.'))
    {
        bail!("invalid policy {name}");
    }
    Ok(())
}

fn validate_text(name: &str, value: &str, max: usize) -> Result<()> {
    if value.trim().is_empty() || value.len() > max || value.contains('\0') {
        bail!("invalid policy {name}");
    }
    Ok(())
}

const fn risk_name(risk: RiskClass) -> &'static str {
    match risk {
        RiskClass::Low => "low",
        RiskClass::Medium => "medium",
        RiskClass::High => "high",
        RiskClass::Critical => "critical",
    }
}

const fn decision_name(decision: PolicyDecision) -> &'static str {
    match decision {
        PolicyDecision::Allow => "allow",
        PolicyDecision::Deny => "deny",
        PolicyDecision::RequireHumanApproval => "require_human_approval",
    }
}

const fn approval_status_name(status: ApprovalStatus) -> &'static str {
    match status {
        ApprovalStatus::Pending => "pending",
        ApprovalStatus::Approved => "approved",
        ApprovalStatus::Denied => "denied",
        ApprovalStatus::Expired => "expired",
        ApprovalStatus::Revoked => "revoked",
    }
}

fn row_to_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<PolicyDecisionRecord> {
    let timestamp: i64 = row.get(1)?;
    let risk: String = row.get(7)?;
    let decision: String = row.get(8)?;
    Ok(PolicyDecisionRecord {
        decision_id: row.get(0)?,
        timestamp_unix_ms: u64::try_from(timestamp).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                1,
                rusqlite::types::Type::Integer,
                Box::new(error),
            )
        })?,
        principal: row.get(2)?,
        task_id: row.get(3)?,
        project_id: row.get(4)?,
        capability: row.get(5)?,
        target: row.get(6)?,
        risk: match risk.as_str() {
            "low" => RiskClass::Low,
            "medium" => RiskClass::Medium,
            "high" => RiskClass::High,
            "critical" => RiskClass::Critical,
            _ => return Err(rusqlite::Error::InvalidQuery),
        },
        decision: match decision.as_str() {
            "allow" => PolicyDecision::Allow,
            "deny" => PolicyDecision::Deny,
            "require_human_approval" => PolicyDecision::RequireHumanApproval,
            _ => return Err(rusqlite::Error::InvalidQuery),
        },
        approval_id: row.get(9)?,
        result: row.get(10)?,
        correlation_id: row.get(11)?,
    })
}

fn row_to_approval(row: &rusqlite::Row<'_>) -> rusqlite::Result<ApprovalRecord> {
    let status: String = row.get(2)?;
    let risk: String = row.get(8)?;
    let created: i64 = row.get(9)?;
    let expires: i64 = row.get(10)?;
    let decided: Option<i64> = row.get(11)?;
    let unsigned = |column: usize, value: i64| {
        u64::try_from(value).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                column,
                rusqlite::types::Type::Integer,
                Box::new(error),
            )
        })
    };
    Ok(ApprovalRecord {
        approval_id: row.get(0)?,
        decision_id: row.get(1)?,
        status: match status.as_str() {
            "pending" => ApprovalStatus::Pending,
            "approved" => ApprovalStatus::Approved,
            "denied" => ApprovalStatus::Denied,
            "expired" => ApprovalStatus::Expired,
            "revoked" => ApprovalStatus::Revoked,
            _ => return Err(rusqlite::Error::InvalidQuery),
        },
        principal: row.get(3)?,
        task_id: row.get(4)?,
        project_id: row.get(5)?,
        capability: row.get(6)?,
        target: row.get(7)?,
        risk: match risk.as_str() {
            "medium" => RiskClass::Medium,
            "high" => RiskClass::High,
            "critical" => RiskClass::Critical,
            _ => return Err(rusqlite::Error::InvalidQuery),
        },
        created_at_unix_ms: unsigned(9, created)?,
        expires_at_unix_ms: unsigned(10, expires)?,
        decided_at_unix_ms: decided.map(|value| unsigned(11, value)).transpose()?,
        decided_by: row.get(12)?,
        reason: row.get(13)?,
    })
}

#[derive(Debug, Clone, Copy, Default)]
pub struct PolicyEngine;

impl PolicyEngine {
    pub fn decide(&self, request: &PolicyRequest<'_>, now_unix_ms: u64) -> PolicyDecision {
        if !valid_identifier(request.principal)
            || !valid_identifier(request.capability)
            || request.target.trim().is_empty()
        {
            return PolicyDecision::Deny;
        }

        if request.baseline_capabilities.contains(&request.capability)
            && request.risk <= RiskClass::Low
        {
            return PolicyDecision::Allow;
        }

        if let Some(grant) = request.active_grant
            && grant_matches(grant, request, now_unix_ms)
        {
            return PolicyDecision::Allow;
        }

        match request.risk {
            RiskClass::Low => PolicyDecision::Deny,
            RiskClass::Medium | RiskClass::High | RiskClass::Critical => {
                PolicyDecision::RequireHumanApproval
            }
        }
    }
}

fn grant_matches(grant: &CapabilityGrant, request: &PolicyRequest<'_>, now: u64) -> bool {
    grant.expires_at_unix_ms > now
        && !grant.approval_id.trim().is_empty()
        && grant.principal == request.principal
        && Some(grant.task_id.as_str()) == request.task_id
        && Some(grant.project_id.as_str()) == request.project_id
        && grant.capability == request.capability
        && grant.target == request.target
}

fn valid_identifier(value: &str) -> bool {
    let value = value.trim();
    !value.is_empty()
        && value.len() <= 200
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'_' | b'-' | b'.'))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn request<'a>(risk: RiskClass, grant: Option<&'a CapabilityGrant>) -> PolicyRequest<'a> {
        PolicyRequest {
            principal: "agent:builder",
            task_id: Some("task-1"),
            project_id: Some("valkhana"),
            capability: "filesystem:project-read",
            target: "/worktrees/task-1",
            risk,
            baseline_capabilities: &["filesystem:project-read"],
            active_grant: grant,
        }
    }

    #[test]
    fn allows_only_low_risk_static_baseline_capabilities() {
        let engine = PolicyEngine;
        assert_eq!(
            engine.decide(&request(RiskClass::Low, None), 10),
            PolicyDecision::Allow
        );
        assert_eq!(
            engine.decide(&request(RiskClass::High, None), 10),
            PolicyDecision::RequireHumanApproval
        );
    }

    #[test]
    fn exact_unexpired_task_scoped_grant_allows_elevation() {
        let grant = CapabilityGrant {
            principal: "agent:builder".into(),
            task_id: "task-1".into(),
            project_id: "valkhana".into(),
            capability: "filesystem:project-read".into(),
            target: "/worktrees/task-1".into(),
            expires_at_unix_ms: 100,
            approval_id: "approval-1".into(),
        };
        assert_eq!(
            PolicyEngine.decide(&request(RiskClass::High, Some(&grant)), 99),
            PolicyDecision::Allow
        );
    }

    #[test]
    fn expired_or_wrong_scope_grants_fail_closed_to_approval() {
        let mut grant = CapabilityGrant {
            principal: "agent:builder".into(),
            task_id: "task-1".into(),
            project_id: "valkhana".into(),
            capability: "filesystem:project-read".into(),
            target: "/worktrees/task-1".into(),
            expires_at_unix_ms: 100,
            approval_id: "approval-1".into(),
        };
        assert_eq!(
            PolicyEngine.decide(&request(RiskClass::High, Some(&grant)), 100),
            PolicyDecision::RequireHumanApproval
        );
        grant.task_id = "another-task".into();
        assert_eq!(
            PolicyEngine.decide(&request(RiskClass::High, Some(&grant)), 10),
            PolicyDecision::RequireHumanApproval
        );
    }

    #[test]
    fn malformed_identity_is_denied() {
        let mut request = request(RiskClass::Low, None);
        request.principal = "agent:builder with spaces";
        assert_eq!(PolicyEngine.decide(&request, 0), PolicyDecision::Deny);
    }

    #[test]
    fn parses_typed_agent_profiles_from_canonical_permissions_config() {
        let root = tempfile::tempdir().unwrap();
        fs::write(
            root.path().join("permissions.yaml"),
            "schema_version: 1\nagents:\n  agent:builder:\n    profile: workspace\n    capabilities: [github:repo-write]\n    filesystem:\n      write: [/task/worktree]\n    shell: true\n    network:\n      allow: [github.com]\n    docker: project_only\n    sudo: false\n  agent:reviewer:\n    profile: observe\n",
        )
        .unwrap();
        let config = ConfigSet::load(root.path()).unwrap();
        let policy = PolicyConfiguration::from_config(&config).unwrap();
        assert!(policy.baseline_allows("agent:builder", "worktree:read-write"));
        assert!(policy.baseline_allows("agent:builder", "github:repo-write"));
        assert!(!policy.baseline_allows("agent:reviewer", "shell:workspace"));
        assert!(policy.baseline_allows("service:valkhana", "hermes:task-admit-triage"));
        assert!(!policy.baseline_allows("service:valkhana", "hermes:task-dispatch"));
    }

    #[test]
    fn rejects_persistent_admin_and_unknown_profiles() {
        for profile in ["admin", "invented"] {
            let root = tempfile::tempdir().unwrap();
            fs::write(
                root.path().join("permissions.yaml"),
                format!("schema_version: 1\nagents:\n  agent:builder:\n    profile: {profile}\n"),
            )
            .unwrap();
            let config = ConfigSet::load(root.path()).unwrap();
            assert!(PolicyConfiguration::from_config(&config).is_err());
        }
    }

    fn decision(id: &str, timestamp: u64) -> PolicyDecisionRecord {
        PolicyDecisionRecord {
            decision_id: id.into(),
            timestamp_unix_ms: timestamp,
            principal: "agent:builder".into(),
            task_id: Some("task-1".into()),
            project_id: Some("valkhana".into()),
            capability: "filesystem:project-write".into(),
            target: "/worktrees/task-1".into(),
            risk: RiskClass::High,
            decision: PolicyDecision::RequireHumanApproval,
            approval_id: None,
            result: Some("approval requested".into()),
            correlation_id: Some("correlation-1".into()),
        }
    }

    #[test]
    fn persists_append_only_private_policy_decisions() {
        let root = tempfile::tempdir().unwrap();
        let ledger = PolicyLedger::open(root.path()).unwrap();
        let first = decision("decision-1", 10);
        ledger.append(&first).unwrap();
        assert_eq!(ledger.get("decision-1").unwrap(), Some(first.clone()));
        assert!(ledger.append(&first).is_err());
        assert_eq!(
            fs::metadata(root.path().join("policy"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(root.path().join("policy/decisions.db"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }

    #[test]
    fn recent_policy_decisions_are_bounded_and_newest_first() {
        let root = tempfile::tempdir().unwrap();
        let ledger = PolicyLedger::open(root.path()).unwrap();
        ledger.append(&decision("decision-1", 10)).unwrap();
        ledger.append(&decision("decision-2", 20)).unwrap();
        let recent = ledger.recent(1).unwrap();
        assert_eq!(recent.len(), 1);
        assert_eq!(recent[0].decision_id, "decision-2");
    }

    #[test]
    fn invalid_policy_ledger_inputs_fail_before_sql() {
        let root = tempfile::tempdir().unwrap();
        let ledger = PolicyLedger::open(root.path()).unwrap();
        let mut invalid = decision("decision with spaces", 10);
        assert!(ledger.append(&invalid).is_err());
        invalid.decision_id = "decision-1".into();
        invalid.target = "\0".into();
        assert!(ledger.append(&invalid).is_err());
        assert!(PolicyLedger::open(Path::new("relative")).is_err());
    }

    fn evaluation(capability: &str, risk: RiskClass) -> PolicyEvaluationInput {
        PolicyEvaluationInput {
            principal: "agent:builder".into(),
            task_id: Some("task-1".into()),
            project_id: Some("valkhana".into()),
            capability: capability.into(),
            target: "/worktrees/task-1".into(),
            risk,
            correlation_id: Some("correlation-1".into()),
        }
    }

    #[test]
    fn policy_service_persists_every_returned_baseline_decision() {
        let config_root = tempfile::tempdir().unwrap();
        fs::write(
            config_root.path().join("permissions.yaml"),
            "schema_version: 1\nagents:\n  agent:builder:\n    profile: workspace\n",
        )
        .unwrap();
        let config = ConfigSet::load(config_root.path()).unwrap();
        let configuration = PolicyConfiguration::from_config(&config).unwrap();
        let state_root = tempfile::tempdir().unwrap();
        let service = PolicyService::new(
            configuration,
            PolicyLedger::open(state_root.path()).unwrap(),
        );

        let allowed = service
            .evaluate_at(evaluation("worktree:read-write", RiskClass::Low), 100)
            .unwrap();
        assert_eq!(allowed.decision, PolicyDecision::Allow);
        let approval = service
            .evaluate_at(evaluation("network:production", RiskClass::High), 101)
            .unwrap();
        assert_eq!(approval.decision, PolicyDecision::RequireHumanApproval);

        let records = service.recent(10).unwrap();
        assert_eq!(records, vec![approval, allowed]);
    }

    #[test]
    fn policy_service_does_not_accept_caller_asserted_elevation() {
        let state_root = tempfile::tempdir().unwrap();
        let service = PolicyService::new(
            PolicyConfiguration::default(),
            PolicyLedger::open(state_root.path()).unwrap(),
        );
        let record = service
            .evaluate_at(evaluation("shell:system-scoped", RiskClass::Critical), 100)
            .unwrap();
        assert_eq!(record.decision, PolicyDecision::RequireHumanApproval);
        let approval_id = record.approval_id.unwrap();
        assert_eq!(
            service
                .ledger
                .approval(&approval_id, 100)
                .unwrap()
                .unwrap()
                .status,
            ApprovalStatus::Pending
        );
        let repeated = service
            .evaluate_at(evaluation("shell:system-scoped", RiskClass::Critical), 101)
            .unwrap();
        assert_eq!(repeated.approval_id.as_deref(), Some(approval_id.as_str()));
        assert_eq!(service.ledger.recent_approvals(10, 101).unwrap().len(), 1);
    }

    #[test]
    fn approved_grant_is_exact_expiring_and_revocable() {
        let state_root = tempfile::tempdir().unwrap();
        let service = PolicyService::new(
            PolicyConfiguration::default(),
            PolicyLedger::open(state_root.path()).unwrap(),
        );
        let first = service
            .evaluate_at(evaluation("shell:system-scoped", RiskClass::Critical), 100)
            .unwrap();
        let approval_id = first.approval_id.unwrap();
        let approved = service
            .transition_approval_at(
                &approval_id,
                &ApprovalAction::Approve {
                    expires_in_ms: 1_000,
                },
                "human:jovaughn",
                "approved maintenance task",
                200,
            )
            .unwrap();
        assert_eq!(approved.status, ApprovalStatus::Approved);

        let allowed = service
            .evaluate_at(evaluation("shell:system-scoped", RiskClass::Critical), 201)
            .unwrap();
        assert_eq!(allowed.decision, PolicyDecision::Allow);
        assert_eq!(allowed.approval_id.as_deref(), Some(approval_id.as_str()));

        let revoked = service
            .transition_approval_at(
                &approval_id,
                &ApprovalAction::Revoke,
                "human:jovaughn",
                "maintenance complete",
                300,
            )
            .unwrap();
        assert_eq!(revoked.status, ApprovalStatus::Revoked);
        let after_revoke = service
            .evaluate_at(evaluation("shell:system-scoped", RiskClass::Critical), 301)
            .unwrap();
        assert_eq!(after_revoke.decision, PolicyDecision::RequireHumanApproval);
        assert_ne!(after_revoke.approval_id, Some(approval_id));
    }

    #[test]
    fn approval_expiry_and_invalid_transitions_fail_closed() {
        let state_root = tempfile::tempdir().unwrap();
        let service = PolicyService::new(
            PolicyConfiguration::default(),
            PolicyLedger::open(state_root.path()).unwrap(),
        );
        let pending = service
            .evaluate_at(evaluation("network:production", RiskClass::High), 100)
            .unwrap();
        let approval_id = pending.approval_id.unwrap();
        service
            .transition_approval_at(
                &approval_id,
                &ApprovalAction::Approve { expires_in_ms: 100 },
                "human:jovaughn",
                "one operation",
                200,
            )
            .unwrap();
        assert_eq!(
            service
                .ledger
                .approval(&approval_id, 300)
                .unwrap()
                .unwrap()
                .status,
            ApprovalStatus::Expired
        );
        assert!(
            service
                .transition_approval_at(
                    &approval_id,
                    &ApprovalAction::Deny,
                    "human:jovaughn",
                    "too late",
                    301,
                )
                .is_err()
        );
        assert!(
            service
                .transition_approval_at(
                    "missing",
                    &ApprovalAction::Deny,
                    "agent:builder",
                    "self approval is forbidden",
                    301,
                )
                .is_err()
        );
        assert!(
            service
                .transition_approval_at(
                    "missing",
                    &ApprovalAction::Approve {
                        expires_in_ms: 86_400_001,
                    },
                    "human:jovaughn",
                    "invalid duration",
                    301,
                )
                .is_err()
        );
    }

    #[test]
    fn authorization_contract_cannot_confuse_deny_or_approval_with_allow() {
        let config_root = tempfile::tempdir().unwrap();
        fs::write(
            config_root.path().join("permissions.yaml"),
            "schema_version: 1\nagents:\n  agent:builder:\n    profile: workspace\n",
        )
        .unwrap();
        let config = ConfigSet::load(config_root.path()).unwrap();
        let state_root = tempfile::tempdir().unwrap();
        let service = PolicyService::new(
            PolicyConfiguration::from_config(&config).unwrap(),
            PolicyLedger::open(state_root.path()).unwrap(),
        );
        assert!(matches!(
            service
                .authorize_at(evaluation("worktree:read-write", RiskClass::Low), 100)
                .unwrap(),
            PolicyAuthorization::Authorized(_)
        ));
        assert!(matches!(
            service
                .authorize_at(evaluation("network:production", RiskClass::Low), 101)
                .unwrap(),
            PolicyAuthorization::Denied(_)
        ));
        assert!(matches!(
            service
                .authorize_at(evaluation("network:production", RiskClass::High), 102)
                .unwrap(),
            PolicyAuthorization::ApprovalRequired(_)
        ));
        assert_eq!(service.recent(10).unwrap().len(), 3);
    }
}
