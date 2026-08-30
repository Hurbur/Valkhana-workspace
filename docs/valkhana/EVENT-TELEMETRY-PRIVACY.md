# ValKhana event and telemetry privacy boundary

Last updated: 2026-08-30 UTC

## Current implemented slice

`valkhana-events` now provides the shared versioned event envelope plus a
bounded, in-process Core journal. Core exposes it read-only at
`GET /v1/events?limit=<1..1000>`.

The journal is an operational projection, not task authority and not the
durable security audit system. Policy decisions continue to be written first
to the private SQLite policy ledger. Only after that write succeeds does Core
best-effort project the decision into the event journal.

| Property | Current behavior |
|---|---|
| Detailed retention | 24 hours in memory |
| Capacity | 10,000 records, oldest first eviction |
| Query bound | 1–1,000 newest-first records |
| Purge | explicit in-process API; no public UDS mutation endpoint |
| Storage | process memory only; Core restart clears the projection |
| Durable audit | policy decisions and approvals stay in private SQLite |
| Streaming/export | not yet implemented |

## Metadata and redaction rules

Telemetry is metadata-first. Raw prompts, tool output, file content,
conversation transcripts, credentials, and arbitrary caller metadata are not
retained by this journal.

The event library permits only bounded identifier metadata for model/provider,
tool/command category, capability, policy decision, error/exit category,
review/test outcome, and route; bounded numeric counts for tokens, CPU time,
peak memory, exit code, and retries; and explicit boolean result flags.
Unknown metadata keys are removed before storage and counted in
`redacted_fields`. Invalid types and malformed identifiers fail closed.

## Deliberate limits and next work

- The current retention policy is deliberately a bounded local operational
  window. Aggregated long-term metrics, configurable per-project opt-out or
  stricter policy, journald integration validation, SSE, and remote export are
  still open.
- The policy SQLite ledger remains the security/audit record. A Core restart
  must not erase approval or deny evidence, while it may erase this event
  projection.
- A public event-ingestion or purge endpoint is intentionally absent; it would
  let same-user clients forge or erase operational evidence.
- The qualified Hermes v0.20.2 build has no supported native approval object
  for its Kanban lifecycle commands. High-impact Core requests therefore stay
  pending/non-executable in production until that native bridge exists; a
  parallel Core approval UI would violate the documented ownership contract.

## Verification

- `valkhana-events`: metadata redaction, invalid-input rejection,
  capacity/age/query bounds, and purge tests pass.
- `valkhana-core`: read-only endpoint, redaction projection, invalid query,
  and method-rejection tests pass.
- Full `cargo test --workspace` and strict workspace Clippy passed on
  2026-08-30.
- Installed Core was updated and returned healthy health responses plus
  `{"events":[]}` on the private Unix socket. Empty output is expected until
  a Core policy evaluation occurs after process start.
