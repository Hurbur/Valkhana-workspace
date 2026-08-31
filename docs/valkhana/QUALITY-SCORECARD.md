# ValKhana quality scorecard

Last assessed: 2026-08-30 UTC
Scope: completed core daemon, Tauri/dashboard health, Hermes task adapters and protected policy-gated lifecycle requests, XDG configuration, bounded metadata-only event projection, encrypted SecretStore backend, Linux Tauri/Electron SSR-to-Core service authentication, and dashboard-key rotation/revocation
Required gate: **92/100**
Current score: **96/100 — PASS**

This score does not claim that the complete v1.3.3 architecture is finished. Later phases receive their own assessment before being marked complete.

| Dimension | Weight | Score | Evidence and deductions |
|---|---:|---:|---|
| Architecture alignment | 25 | 25 | Preserves the existing UI and Electron path, adds Rust beside it, keeps Tauri thin, uses the documented XDG boundaries, keeps Hermes as task authority, and limits Rust state to ValKhana's separate global automation control. |
| Security and isolation | 20 | 20 | Private runtime/socket modes, exclusive ownership lock, bounded response, timeout, systemd sandboxing/resource controls, narrow Tauri origin scope, per-launch authenticated sidecar handshake, durable nonce-digest replay protection, and an encrypted namespaced Secret Service backend with no plaintext downgrade. Service identity is explicitly not overstated as human presence. |
| Reliability and lifecycle | 20 | 17 | Readiness notification, graceful cleanup, second-instance regression, supervised restart, atomic versioned state, read-after-write Hermes projection, and safe `STOPPED` initialization. Deducted 3 because interactive desktop recovery, assignment/promotion gates, and unsupported legacy task controls remain open. |
| Test and build evidence | 20 | 20 | Root and Cloudflare-worker TypeScript projects typecheck cleanly; 149 Vitest files/865 tests, workspace Rust tests, strict Clippy, router/process/transport tests, frontend production build, real Tauri builds, pinned Rust 1.88 MSRV, isolated historical Hermes contract evidence pass. GitHub run `33343179153` also passed the repaired clean-checkout sidecar pipeline. |
| Operability and continuity | 15 | 14 | Installed service verification, security score, canonical checklist/changelog, recovery branch, vault mirrors, and verified Linux Rust CI. Deducted 1 because the installed local service lacks a configured compatible Hermes deployment, so migrated task routes currently fail closed rather than work end-to-end. |
| **Total** | **100** | **96** | **Gate passed for this slice.** |

## Evidence captured

- `scripts/valkhana-core-service.sh verify` returned the exact documented health JSON.
- `cargo test --workspace` passed.
- `cargo clippy --workspace --all-targets -- -D warnings` passed.
- `pnpm exec vitest run src/lib/valkhana-core.test.ts` passed 3/3 tests.
- `cargo test -p valkhana-api` passed 4/4 transport tests.
- `pnpm build` passed.
- `pnpm tauri build --debug --no-bundle` produced `target/debug/valkhana-desktop`.
- `systemd-analyze --user security valkhana-core.service` previously reported `2.0 OK`.
- The policy-enabled installed service now runs with `StateDirectory=valkhana`, `ProtectHome=read-only`, and `ProtectSystem=strict`; live verification returned exact health, SQLite integrity `ok`, schema version 1, private `0700/0600` modes, and the exposure score remains `2.0 OK`.
- `cargo test --workspace --locked` and strict Clippy pass under the pinned Rust 1.88.0 toolchain.
- `pnpm tauri:sidecar:verify` proves authenticated readiness, unauthorized rejection, SSR HTML, embedded assets, and cleanup.
- A release Tauri process spawned and stopped the packaged SSR companion correctly.
- The legacy Electron Linux packaging path completed successfully after the Tauri additions.
- The read-only Hermes adapter tests pass, and its core route was exercised against a controlled mock contract.
- Azure inspection pinned Hermes Agent `v0.20.0` at commit `f5be9236e00ddf2f2a412697f267078fc4ee068e`; an isolated canary board verified board isolation and post-mutation lifecycle behavior without touching the default queue.
- The XDG configuration slice has nine focused tests and is exercised by the installed service startup. Every present canonical YAML document is size-bounded and schema-version validated before readiness.
- The state/event slice adds six focused tests; the complete locked workspace test suite and strict Clippy pass. State uses an exclusive writer lock, file and directory sync, atomic rename, schema rejection, and a fail-closed default.
- The Hermes read path now projects typed tasks only from an explicit validated board and rechecks the v0.20.2 compatibility floor. Its wire shape was verified against the isolated Azure candidate; the installed local service correctly returns 503 without a supported CLI.
- The documented project-to-board mapping is now a typed startup contract rather than an implicit current-board convention; malformed or path-unsafe mappings prevent readiness.
- The TanStack server bridge is path-allowlisted, timeout/size bounded, and tested over real temporary Unix sockets; the production client/SSR build passes.
- Initial task mutation is constrained to idempotent, configured-board, unassigned Hermes `triage` admission. Exact command arguments and live candidate behavior are proven; no worker can dispatch from this path.
- The first competing task authority is retired atomically: TypeScript task routes now read and mutate only through Core/Hermes, the JSON store is read-only, supported transitions read state back, and unsupported behavior fails explicitly rather than diverging.
- The second task/board authority is retired: Swarm Board and Claude Tasks no longer write Hermes SQLite, the dashboard plugin, or `swarm2-kanban.json`; 25 focused tests and the production SSR bundle prove the Core-only switch.
- The legacy Swarm lifecycle endpoint is observation-only: worker prompt/restart/renew/handoff/auto-sweep authority was removed, with route tests proving every POST mutation returns an explicit conflict.
- Legacy dispatch, orchestrator-loop continuation, direct checkpoint writes, and native Conductor fallback are removed. Twelve focused authority tests and the production client/SSR build pass; legacy mission history remains a read-only migration projection.
- Runtime roster metadata remains readable, but its web/API YAML writer has been removed; focused schema and route tests prove the registry cannot be mutated through the legacy endpoint.
- Shadow worker-runtime reset and native mission cancellation paths are removed; authenticated legacy endpoints now fail explicitly while read-only history and supported external cleanup remain.
- The Rust policy and trusted-component contracts include typed profile validation, fail-closed component selection, fourteen policy tests, a private schema-versioned SQLite decision/approval ledger, exact expiring and revocable grants, and fourteen Core tests. Triage admission, fail-safe blocking, and request-review each write a distinct task-scoped `service:valkhana` allow decision before Hermes and stop if policy is unavailable. The event crate has five focused metadata/retention tests, while Core adds a read-only event-route test. The full Rust workspace and strict Clippy pass. Complete/archive actions, a Hermes-native authenticated human approval bridge, and external-system PEPs are not yet claimed.
- `valkhana-secrets` passes focused tests and strict Clippy. Its encrypted Secret Service backend passed read-only and disposable lifecycle probes. A ValKhana-owned key is provisioned; Tauri and packaged Linux Electron hand it only to the trusted SSR child; complete/archive requests use payload-bound HMAC proofs with timestamp and one-use nonce checks; negative tests pass; and the installed Core accepted a live signed probe. The Electron launcher was also proven with an unavailable session bus: SSR remained available, an inherited token was removed, and protected mutation returned 503. macOS/Windows handoff, locked-wallet testing, stronger same-user isolation, and human-presence authorization remain unclaimed.
- The operator key lifecycle was exercised live without exporting either key: Core accepted current and previous signatures during the fixed five-minute overlap, finalization removed previous-key access immediately, the revocation marker disabled authentication before cleanup, and reprovisioning restored only a new current key. Rotation and revocation are now claimed; cross-platform handoff remains open.
- A guarded ignored integration test ran inside a disposable D-Bus session with isolated home/XDG roots and a separate GNOME Secret Service daemon. After the fixture locked its default collection, ValKhana's probe and metadata access failed and the collection remained locked. The real KDE wallet was never touched. Locked-wallet behavior is now claimed; cross-platform desktop handoff remains open.
- Read-only Azure CLI inspection established the exact qualified Hermes v0.20.2 assignment, dependency, promotion, reclaim/reassign, and review-rework contracts. Core now accepts them only from the HMAC-authenticated dashboard service, evaluates them as high risk, and binds approval scope to the exact payload digest. An integration test proves deduplicated pending state, no pre-approval Hermes call, exact human-grant execution, and canonical read-back. Worker `claim`/`dispatch` and the authenticated human approval bridge remain unimplemented.
- `valkhana-events` now enforces metadata-only retention rather than storing arbitrary JSON: raw content/secret-shaped keys are removed, invalid metadata fails closed, and Core provides a bounded read-only 24-hour/10,000-record projection. Durable policy decisions remain in SQLite. Full Rust tests, strict Clippy, and a live private-socket event query pass; configurable retention, journald/SSE/export, aggregation, and per-project controls remain open.

## Required improvements before the next desktop milestone closes

- Exercise core online, offline, and recovery behavior visibly in the actual desktop webview.
- Keep the repaired Linux Rust workflow as a release gate; it must prepare the Tauri sidecar from a clean checkout before Cargo executes.

## Scoring rule

Re-run the relevant tests and update this file after every material slice. A slice scoring below 92 remains in progress. Never inflate a score by including requirements outside the stated scope or by treating deferred work as verified.
