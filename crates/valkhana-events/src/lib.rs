//! Shared, metadata-first telemetry contract for ValKhana services.

use std::{
    collections::{BTreeMap, VecDeque},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const EVENT_SCHEMA_VERSION: u32 = 1;
pub const DEFAULT_DETAILED_RETENTION_MS: u64 = 24 * 60 * 60 * 1_000;
pub const DEFAULT_EVENT_CAPACITY: usize = 10_000;
const MAX_EVENT_CAPACITY: usize = 100_000;
const MAX_STRING_BYTES: usize = 256;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventEnvelope {
    pub schema_version: u32,
    pub timestamp: String,
    pub service: String,
    pub level: EventLevel,
    pub event: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trace_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hermes_board: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hermes_task_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hermes_run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worker_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome: Option<EventOutcome>,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub metadata: Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EventLevel {
    Trace,
    Debug,
    Info,
    Warn,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventOutcome {
    Success,
    Failure,
    Denied,
    Cancelled,
}

impl EventEnvelope {
    pub fn new(
        timestamp: impl Into<String>,
        service: impl Into<String>,
        event: impl Into<String>,
    ) -> Self {
        Self {
            schema_version: EVENT_SCHEMA_VERSION,
            timestamp: timestamp.into(),
            service: service.into(),
            level: EventLevel::Info,
            event: event.into(),
            trace_id: None,
            request_id: None,
            model_request_id: None,
            hermes_board: None,
            hermes_task_id: None,
            hermes_run_id: None,
            worker_id: None,
            duration_ms: None,
            outcome: None,
            metadata: Value::Null,
        }
    }

    pub fn sanitize(mut self) -> Result<(Self, usize)> {
        if self.schema_version != EVENT_SCHEMA_VERSION {
            bail!("unsupported event schema version");
        }
        validate_text("timestamp", &self.timestamp, 64, false)?;
        validate_identifier("service", &self.service)?;
        validate_identifier("event", &self.event)?;
        for (name, value) in [
            ("trace_id", self.trace_id.as_deref()),
            ("request_id", self.request_id.as_deref()),
            ("model_request_id", self.model_request_id.as_deref()),
            ("hermes_board", self.hermes_board.as_deref()),
            ("hermes_task_id", self.hermes_task_id.as_deref()),
            ("hermes_run_id", self.hermes_run_id.as_deref()),
            ("worker_id", self.worker_id.as_deref()),
        ] {
            if let Some(value) = value {
                validate_identifier(name, value)?;
            }
        }
        let (metadata, redacted_fields) = sanitize_metadata(self.metadata)?;
        self.metadata = metadata;
        Ok((self, redacted_fields))
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RecordedEvent {
    pub sequence: u64,
    pub recorded_at_unix_ms: u64,
    pub redacted_fields: usize,
    #[serde(flatten)]
    pub envelope: EventEnvelope,
}

#[derive(Debug, Clone)]
pub struct EventJournal {
    inner: Arc<Mutex<JournalState>>,
    capacity: usize,
    retention_ms: u64,
}

#[derive(Debug, Default)]
struct JournalState {
    next_sequence: u64,
    events: VecDeque<RecordedEvent>,
}

impl Default for EventJournal {
    fn default() -> Self {
        Self::new(DEFAULT_EVENT_CAPACITY, DEFAULT_DETAILED_RETENTION_MS)
            .expect("default event journal policy is valid")
    }
}

impl EventJournal {
    pub fn new(capacity: usize, retention_ms: u64) -> Result<Self> {
        if capacity == 0 || capacity > MAX_EVENT_CAPACITY {
            bail!("event capacity must be between 1 and {MAX_EVENT_CAPACITY}");
        }
        if retention_ms == 0 {
            bail!("event retention must be positive");
        }
        Ok(Self {
            inner: Arc::new(Mutex::new(JournalState::default())),
            capacity,
            retention_ms,
        })
    }

    pub fn record(&self, envelope: EventEnvelope) -> Result<RecordedEvent> {
        self.record_at(envelope, unix_time_ms()?)
    }

    pub fn record_at(&self, envelope: EventEnvelope, now_unix_ms: u64) -> Result<RecordedEvent> {
        let (envelope, redacted_fields) = envelope.sanitize()?;
        let mut state = self
            .inner
            .lock()
            .map_err(|_| anyhow::anyhow!("event journal lock poisoned"))?;
        prune_expired(&mut state.events, now_unix_ms, self.retention_ms);
        state.next_sequence = state
            .next_sequence
            .checked_add(1)
            .ok_or_else(|| anyhow::anyhow!("event sequence exhausted"))?;
        let record = RecordedEvent {
            sequence: state.next_sequence,
            recorded_at_unix_ms: now_unix_ms,
            redacted_fields,
            envelope,
        };
        state.events.push_back(record.clone());
        while state.events.len() > self.capacity {
            state.events.pop_front();
        }
        Ok(record)
    }

    pub fn recent(&self, limit: usize) -> Result<Vec<RecordedEvent>> {
        self.recent_at(limit, unix_time_ms()?)
    }

    pub fn recent_at(&self, limit: usize, now_unix_ms: u64) -> Result<Vec<RecordedEvent>> {
        if limit == 0 || limit > 1_000 {
            bail!("event query limit must be between 1 and 1000");
        }
        let mut state = self
            .inner
            .lock()
            .map_err(|_| anyhow::anyhow!("event journal lock poisoned"))?;
        prune_expired(&mut state.events, now_unix_ms, self.retention_ms);
        Ok(state.events.iter().rev().take(limit).cloned().collect())
    }

    pub fn purge(&self) -> Result<usize> {
        let mut state = self
            .inner
            .lock()
            .map_err(|_| anyhow::anyhow!("event journal lock poisoned"))?;
        let count = state.events.len();
        state.events.clear();
        Ok(count)
    }
}

fn sanitize_metadata(metadata: Value) -> Result<(Value, usize)> {
    if metadata.is_null() {
        return Ok((Value::Null, 0));
    }
    let Value::Object(input) = metadata else {
        bail!("event metadata must be an object or null");
    };
    let mut output = Map::new();
    let mut redacted = 0;
    for (key, value) in input {
        if identifier_metadata_keys().contains_key(key.as_str()) {
            if let Value::String(text) = &value {
                validate_identifier(&format!("metadata.{key}"), text)?;
                output.insert(key, value);
            } else {
                bail!("event metadata field must be an identifier string");
            }
        } else if numeric_metadata_keys().contains_key(key.as_str()) {
            if value.is_number() {
                output.insert(key, value);
            } else {
                bail!("event metadata field must be numeric");
            }
        } else if boolean_metadata_keys().contains_key(key.as_str()) {
            if value.is_boolean() {
                output.insert(key, value);
            } else {
                bail!("event metadata field must be boolean");
            }
        } else {
            redacted += 1;
        }
    }
    Ok((Value::Object(output), redacted))
}

fn identifier_metadata_keys() -> BTreeMap<&'static str, ()> {
    [
        "model",
        "provider",
        "tool",
        "capability",
        "policy_decision",
        "approval_status",
        "command_category",
        "error_category",
        "exit_category",
        "review_outcome",
        "test_outcome",
        "route",
    ]
    .into_iter()
    .map(|key| (key, ()))
    .collect()
}

fn numeric_metadata_keys() -> BTreeMap<&'static str, ()> {
    [
        "input_tokens",
        "output_tokens",
        "cached_tokens",
        "cpu_time_ms",
        "peak_memory_bytes",
        "exit_code",
        "retry_count",
    ]
    .into_iter()
    .map(|key| (key, ()))
    .collect()
}

fn boolean_metadata_keys() -> BTreeMap<&'static str, ()> {
    ["review_passed", "tests_passed", "cache_hit"]
        .into_iter()
        .map(|key| (key, ()))
        .collect()
}

fn validate_identifier(name: &str, value: &str) -> Result<()> {
    validate_text(name, value, MAX_STRING_BYTES, true)
}

fn validate_text(name: &str, value: &str, max: usize, identifier: bool) -> Result<()> {
    if value.is_empty() || value.len() > max || value.chars().any(char::is_control) {
        bail!("invalid event {name}");
    }
    if identifier
        && !value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'_' | b'-' | b'.' | b'/')
        })
    {
        bail!("invalid event {name}");
    }
    Ok(())
}

fn prune_expired(events: &mut VecDeque<RecordedEvent>, now: u64, retention_ms: u64) {
    while events
        .front()
        .is_some_and(|event| now.saturating_sub(event.recorded_at_unix_ms) >= retention_ms)
    {
        events.pop_front();
    }
}

fn unix_time_ms() -> Result<u64> {
    Ok(u64::try_from(
        SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis(),
    )?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_the_documented_logical_envelope() {
        let mut event = EventEnvelope::new(
            "2026-08-17T12:00:00Z",
            "valkhana-intelligence",
            "task_classified",
        );
        event.trace_id = Some("trace-1".into());
        event.hermes_task_id = Some("task-1".into());
        event.duration_ms = Some(38);
        event.outcome = Some(EventOutcome::Success);

        let value = serde_json::to_value(event).unwrap();
        assert_eq!(value["schema_version"], 1);
        assert_eq!(value["level"], "info");
        assert_eq!(value["event"], "task_classified");
        assert_eq!(value["outcome"], "success");
        assert!(value.get("request_id").is_none());
        assert!(value.get("metadata").is_none());
    }

    #[test]
    fn rejects_unknown_event_levels() {
        let input = r#"{"schema_version":1,"timestamp":"now","service":"core","level":"fatal","event":"failed"}"#;
        assert!(serde_json::from_str::<EventEnvelope>(input).is_err());
    }

    #[test]
    fn redacts_raw_content_and_retains_only_typed_metadata() {
        let mut event = EventEnvelope::new("2026-08-17T12:00:00Z", "valkhana-core", "route.done");
        event.metadata = serde_json::json!({
            "model": "gpt-5.6",
            "input_tokens": 120,
            "tests_passed": true,
            "prompt": "secret content",
            "tool_output": "raw output",
            "api_key": "never retain"
        });
        let (event, redacted) = event.sanitize().unwrap();
        assert_eq!(redacted, 3);
        assert_eq!(event.metadata["model"], "gpt-5.6");
        assert_eq!(event.metadata["input_tokens"], 120);
        assert_eq!(event.metadata["tests_passed"], true);
        assert!(event.metadata.get("prompt").is_none());
        assert!(event.metadata.get("tool_output").is_none());
        assert!(event.metadata.get("api_key").is_none());
    }

    #[test]
    fn journal_enforces_capacity_age_query_bounds_and_manual_purge() {
        let journal = EventJournal::new(2, 100).unwrap();
        for (time, name) in [(10, "one"), (20, "two"), (30, "three")] {
            journal
                .record_at(EventEnvelope::new("now", "core", name), time)
                .unwrap();
        }
        let recent = journal.recent_at(2, 30).unwrap();
        assert_eq!(
            recent
                .iter()
                .map(|event| event.envelope.event.as_str())
                .collect::<Vec<_>>(),
            ["three", "two"]
        );
        assert!(journal.recent_at(0, 30).is_err());
        assert!(journal.recent_at(1_001, 30).is_err());
        assert!(journal.recent_at(1, 120).unwrap().len() == 1);
        assert_eq!(journal.purge().unwrap(), 1);
        assert!(journal.recent_at(1, 120).unwrap().is_empty());
    }

    #[test]
    fn malformed_or_unbounded_event_data_fails_closed() {
        let mut event = EventEnvelope::new("now", "core", "bad event");
        assert!(event.clone().sanitize().is_err());
        event.event = "valid".into();
        event.metadata = serde_json::json!({"input_tokens": "many"});
        assert!(event.sanitize().is_err());
        assert!(EventJournal::new(0, 1).is_err());
        assert!(EventJournal::new(1, 0).is_err());
    }
}
