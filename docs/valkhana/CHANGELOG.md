# ValKhana architecture migration changelog

This records implementation changes on `architecture/valkhana-v1.3.3`. It is separate from the product release changelog until the migration is ready to land.

## 2026-08-30 — Reproducible clean-checkout Tauri CI preparation

- Diagnosed the GitHub Rust workflow failure: Cargo correctly rejected Tauri's missing external sidecar in a clean checkout, while local workspaces had the intentionally ignored generated file.
- Updated the workflow to install the locked pnpm graph and run the existing `pnpm tauri:prepare` pipeline before Cargo formatting, tests, and Clippy. This produces the sidecar from checked-in sources rather than committing a host-specific binary.
- Locally verified `pnpm tauri:prepare`, authenticated sidecar smoke verification, Cargo formatting, locked workspace tests, and strict Clippy. GitHub run `33343179153` then confirmed the complete repaired workflow from a clean checkout.

## 2026-08-30 — Local TypeScript release gate restored

- Resolved the remaining root TypeScript application and test-contract errors after reconciling the TanStack dependency line. Both root and Cloudflare-worker `tsc --noEmit` commands now pass.
- Verified 149 Vitest files/865 tests, production build, production/full dependency audits, Rust formatting/workspace tests/strict Clippy, and diff integrity locally.
- This is a local-only quality milestone. AWS/deployment-dependent validation remains deferred because no running reviewed replacement target exists.

## 2026-08-30 — Deployment target unavailable

- Recorded that the former Azure ValKhana/Hermes VM has been sunsetted and its proposed AWS successor is neither implemented nor running.
- Azure canary, rollback, and compatibility records remain historical evidence only. Deployment, live Hermes validation, promotion, recovery testing, and release handoff are blocked until a reviewed AWS target exists.

## 2026-08-30 — Live Hermes promotion deferred

- The operator deferred further live Telegram/platform-health work and any Hermes v0.20.2 promotion. The qualified canary and rollback evidence are retained, but no production deployment action may resume without a newly authorized maintenance window.

## 2026-08-30 — TypeScript baseline remediation checkpoint

- Reconciled the incompatible TanStack dependency line by aligning the patched Start 1.168.49, Router 1.170.32, plugin 1.168.35, and companion packages, eliminating the generated route-contract cascade without reintroducing advisories.
- Added missing Cloudflare worker and Three.js declaration dependencies and excluded the worker from the browser/server project so it is checked under its own Cloudflare configuration. The dedicated worker typecheck passes.
- Root `tsc --noEmit` failures fell from 474 to 70. The remainder are explicit application/test contract defects and remain a release blocker; no typecheck suppression was added.

## 2026-08-30 — Durable dashboard-request replay protection

- Replaced process-lifetime authenticated-request nonce tracking with a private SQLite nonce-digest ledger in Core's systemd-managed state directory.
- The ledger keeps only SHA-256 nonce digests until expiry, prunes expired rows, and uses an immediate transaction to atomically reject duplicate valid signed requests across Core restarts.
- Added mode and persistence regression tests: `0700` ledger directory, `0600` database, no raw nonce storage, expiry reuse, and exact replay rejection after a fresh router reopens the same ledger.
- The same-user Secret Service access boundary remains a separate documented residual risk; durable nonce storage does not turn service authentication into human authorization.

## 2026-08-30 — Metadata-only Core event journal

- Added `EventJournal` to `valkhana-events`: a bounded 24-hour/10,000-record in-memory operational projection with oldest-first eviction, newest-first bounded reads, and explicit in-process purge.
- Added strict metadata handling: raw prompt/content/credential fields and arbitrary keys are removed before storage and counted in `redacted_fields`; malformed values fail closed. Only documented identifiers, metrics, and result flags are retained.
- Added read-only `GET /v1/events?limit=1..1000` to Core. There is no public event ingestion or purge endpoint, so same-user clients cannot forge or erase Core event evidence.
- Policy decisions are persisted to the private SQLite audit ledger before a best-effort event projection; a journal failure cannot replace or erase the authoritative audit decision.
- Added unit/router tests for redaction, malformed input, capacity and age retention, query limits, read-only methods, and policy projection. Full workspace Rust tests, strict Clippy, and installed Core health/events checks pass.
- Documented the slice and limits in [`EVENT-TELEMETRY-PRIVACY.md`](EVENT-TELEMETRY-PRIVACY.md). This is not a durable telemetry database, SSE stream, or long-term aggregation service.

## 2026-08-17 — Policy-gated higher-impact Hermes requests

- Exposed qualified assign/unassign, dependency link/unlink, non-forced promote, reclaim/reassign, request-changes, and reopen-review operations through the private Core task endpoint.
- Required the dashboard service's payload-bound HMAC proof before project lookup or policy evaluation. Each operation has a distinct action and capability; compound reassignment signs the canonical `profile + newline + reason` payload.
- Classified these operations as high risk. Without an exact server-owned grant, Core persists and returns one deduplicated pending approval with HTTP 202 and does not invoke Hermes.
- Bound approval targets to the configured board, project, task, capability, and SHA-256 digest of the exact requested input, preventing an approval for one profile, dependency, or reason from authorizing another.
- Added a Core integration test proving pending deduplication, pre-approval non-execution, exact human approval, execution, and canonical read-back. Added dashboard signing coverage for reassignment. Full workspace tests, strict Clippy, and focused Vitest pass.
- Worker `claim` and `dispatch` remain absent. They can own/spawn workers and require real global admission, pause, drain, and recovery enforcement. Human approval mutation also remains unavailable on the general same-user Unix socket.

## 2026-08-17 — Qualified Hermes lifecycle adapter expansion

- Used read-only SSH during the authorized maintenance window to inspect `--help` on the exact isolated Hermes v0.20.2 candidate. No service, board, credential, or deployment state was changed.
- Added typed adapter mutations for assign/unassign, parent-child link/unlink, non-forced promotion with audit reason, reclaim, reclaiming reassign, request-changes, and review reopening.
- Every identifier and reason is bounded and validated before process execution; commands use explicit argv without a shell and read the canonical task back after mutation.
- Added an exact mock-CLI contract test covering all new argv shapes plus unsafe profile and empty-reason rejection. Nine focused Hermes tests, the full locked workspace, strict Clippy, installed Core health, and signed authentication pass.
- These adapter capabilities are now consumed only by the service-authenticated, high-risk policy path described above. `claim` and `dispatch` remain deliberately absent because they own/spawn workers and depend on unfinished automation controls.

## 2026-08-17 — Isolated locked-wallet proof

- Added an ignored integration test guarded by `VALKHANA_ISOLATED_SECRET_SERVICE=1`, so it refuses to run accidentally against a normal desktop session.
- Ran the test inside a disposable D-Bus session, isolated home/XDG roots, and a separate GNOME Secret Service daemon. Fixture setup created and locked the disposable default collection; ValKhana then failed both probe and metadata access without unlocking it.
- The fixture's collection-creation prompt belongs to test setup. The ValKhana code path only calls `ensure_unlocked`, which checks state and returns `Locked`; it does not request an unlock prompt.
- The disposable filesystem was removed after the run. Full locked workspace tests, strict Clippy, installed health, signed authentication, and authored diff hygiene pass afterward.

## 2026-08-17 — Bounded dashboard-key rotation and revocation

- Added operator commands to rotate, verify the previous key without exporting it, finalize rotation, revoke authentication, and safely reprovision.
- Rotation writes an encrypted previous-key envelope before replacing the current key. Core checks both signatures without short-circuiting for at most five minutes; a second rotation is refused until the first is finalized.
- Finalization deletes the previous key immediately. Expired previous envelopes are never accepted, and malformed, future-extended, or unsupported envelopes fail closed.
- Revocation writes a marker before deleting either key, so partial cleanup cannot leave authentication enabled. Tauri and Electron refuse to launch an authenticated SSR child while the marker exists; unrelated desktop capabilities still degrade normally.
- Live drills proved current/previous overlap, finalization, revocation denial, clean reprovisioning, and final namespace cleanup. The installed Core stayed healthy, full locked workspace tests and strict Clippy passed, and both Tauri release and Linux AppImage builds completed.

## 2026-08-17 — Packaged Linux Electron service-auth parity

- Added a small native launcher that validates the Electron runtime and packaged `prod-server.cjs`, retrieves only ValKhana's dashboard/Core key, removes any inherited token, and replaces itself with the SSR process while preserving Electron's IPC channel.
- Rejected Electron `safeStorage` for this boundary after reviewing its official Linux fallback behavior: it can select `basic_text` and would duplicate the canonical credential into an application-managed encrypted blob.
- When Secret Service is missing, locked, malformed, or unavailable, the launcher emits only a generic message and starts SSR without the key. Unrelated desktop features remain available while protected mutations fail closed.
- Proved valid-key startup and unavailable-session-bus degraded startup. A deliberately inherited token was removed and a protected completion returned HTTP 503.
- Updated Linux packaging to build and embed the launcher. The AppImage build passed, the embedded executable matches the verified release binary byte-for-byte, and no token hook or secret ID appears in the client bundle.

## 2026-08-17 — Signed dashboard service identity

- Provisioned a ValKhana-owned `service:dashboard-core` key through the operator-only Secret Service CLI without reading or changing vendor credentials.
- Added versioned HMAC-SHA-256 proofs for protected complete/archive requests, binding service ID, method, exact path, action, payload digest, timestamp, and a random one-use nonce.
- Core retrieves the key directly from Secret Service, rejects missing, wrong, stale, substituted, and replayed proofs before project disclosure or Hermes mutation, and attributes the caller only as `service:valkhana-dashboard`.
- Tauri supplies the key only to its trusted SSR child process. It is not exposed to browser code, request bodies, URLs, logs, or arguments; packaged Linux Electron gained the equivalent boundary in the follow-on entry above.
- Added a signed no-side-effect Core probe and verified it against the installed service with the real provisioned key. Full locked Rust tests, strict Clippy, 26 focused TypeScript tests, production builds, a release Tauri build, installed health, and systemd exposure `2.0 OK` pass.
- Human authorization remains separate: a reusable same-user service key never establishes `human:*`. Rotation/revocation, locked/unavailable wallet drills, and stronger same-user process isolation remain open.

## 2026-08-17 — Encrypted ValKhana SecretStore backend

- Added `valkhana-secrets` with bounded identifiers and values, typed secret classes, metadata-only listing, redacted debug output, dedicated memory zeroization, and reviewed constant-time service-token comparison.
- Implemented the Linux freedesktop Secret Service/KWallet backend using an encrypted Diffie-Hellman transfer session and the default collection. There is no plaintext or plain-session fallback.
- Restricted all lookup, write, list, and delete operations to exact `application=valkhana` attributes. Duplicate IDs, malformed metadata, foreign items, and secret-class changes fail closed.
- Background probes and operations refuse locked collections instead of opening an unsolicited wallet prompt.
- Passed focused tests, strict Clippy, a read-only live KDE Secret Service probe, and a disposable create/read/replace/list/delete drill that removed its test item.
- Added `SECRET-STORE-AND-SERVICE-IDENTITY.md` to distinguish service authentication from human authorization. The freedesktop API does not guarantee per-application access control, so a reusable keyring token is not accepted as proof of human presence against another same-user process.
- Deferred Core/SSR service-token integration until its same-user threat boundary, rotation behavior, and missing/wrong-token tests are implemented. Human approval remains separately gated on Hermes-native approval linkage or an applicable OS/Polkit bridge.

## 2026-08-17 — Policy and trusted-component foundations

- Added systemd `StateDirectory=valkhana` with mode `0700`, allowing only the policy/state root to remain writable under the existing read-only home/system sandbox. The updater now clears a previous start-limit failure before restarting a corrected unit.
- Live update and verification pass: exact health, active/running unit, policy directory `0700`, database `0600`, SQLite integrity `ok`, schema version 1, expected approval/decision/metadata tables, and systemd exposure `2.0 OK`.
- Added the first real policy enforcement point to Hermes triage admission. Core authorizes only the built-in `service:valkhana` capability `hermes:task-admit-triage`, persists the decision before the CLI call, and records the request idempotency key as correlation evidence.
- Extended pre-execution enforcement to `hermes:task-block-needs-input` and `hermes:task-request-review`. These fail-safe transitions are task/project/board scoped and independently recorded before the Hermes command.
- Task admission returns 503 without an initialized policy service and never invokes Hermes in that state. The service identity is Core-owned rather than caller supplied, so the audit record cannot be forged by posting a different principal.
- Policy evaluation now has an explicit authorized/denied/approval-required contract; its HTTP projection uses 200, 403, and 202 respectively while preserving every record in the ledger.
- Fourteen policy tests, twelve Core tests, twenty-two focused TypeScript adapter tests, the full locked workspace, strict Clippy, production client/SSR build, and diff hygiene pass.
- Added server-owned approval states `pending`, `approved`, `denied`, `expired`, and `revoked`, with exact task/project/capability/target scope and a maximum 24-hour elevation.
- Approved grants are resolved from the ledger rather than request bodies, expire automatically, revoke immediately, and cannot be transitioned by an agent principal. Repeated identical requests reuse one pending approval.
- Added read-only private approval-list/detail endpoints. Approval mutation is intentionally not exposed on the general Unix socket because a same-user agent could otherwise claim a human actor and self-elevate.
- Thirteen policy tests, eleven Core route tests, the complete locked workspace suite, formatting, strict Clippy, and diff hygiene pass.
- Added the Core-owned `PolicyService`: configured baseline decisions are written to the ledger before return, while elevated requests require approval and callers cannot assert their own grant.
- Added private `GET` and `POST /v1/policy/decisions` contracts for bounded audit reads and evaluated decisions; an uninitialized service fails closed with HTTP 503.
- Eleven policy tests, ten Core route tests, the complete locked workspace suite, formatting, strict Clippy, and diff hygiene pass.
- Added the private schema-versioned SQLite policy decision ledger under the XDG state root. It enforces strict decision/risk values, bounded fields, append-only decision identifiers, and newest-first reads.
- Core now opens and validates the policy ledger before readiness. Nine focused policy tests, the complete locked workspace suite, formatting, strict Clippy, and diff hygiene pass.
- Added `valkhana-policy` as the Rust-owned PDP contract with typed allow, deny, and require-human-approval decisions.
- Added exact principal/task/project/capability/target matching for expiring approved grants; malformed identities deny and missing/expired elevation fails closed.
- Added `valkhana-components` with a bounded schema-versioned YAML registry for executable supply-chain inputs.
- Autonomous selection requires a registered non-model component in `approved` state; candidate, deprecated, blocked, and unregistered components fail closed.
- Model entries may contain only `model_ref`; duplicate model trust in the registry is rejected because `models.yaml` remains authoritative.
- Added eight focused tests. The complete locked Rust workspace suite and strict Clippy pass.
- Added typed `permissions.yaml` agent-profile parsing for observe, workspace-lite, workspace, research, trusted, system, and exceptional admin; persistent admin assignment is rejected.
- Core validates policy profiles and the optional canonical component registry before readiness.
- Hardened Hermes CLI process start against the narrowly transient Linux `ETXTBSY` condition; other spawn errors remain immediate failures.
- Two consecutive complete locked workspace suites, strict Clippy, and authored diff hygiene pass after integration.
- Saved a durable whole-build checklist at `docs/valkhana/V1.3.3-COMPLETION-CHECKLIST.md` and linked it from the vault.

## 2026-08-17 — Dispatch and checkpoint authority cutover

- Replaced `/api/swarm-dispatch`, `/api/swarm-orchestrator-loop`, and `/api/swarm-checkpoint` mutations with authenticated HTTP 409 Core/Hermes authority boundaries.
- Removed local process/tmux dispatch, continuation routing, runtime checkpoint writes, and mission checkpoint synchronization from reachable production routes.
- Removed Conductor's native Swarm fallback while retaining the supported dashboard Conductor API and read-only legacy mission lookup.
- Added focused regression coverage; 12 authority tests and the production client/SSR build pass.
- Attempted the authorized Hermes v0.20.2 promotion after a verified live backup/restore. Telegram startup failed, and the exact v0.20.0 release/unit were restored without board changes.

## 2026-08-17 — Shadow runtime reset and cancellation removed

### Changed

- Deleted `swarm-runtime-reset.ts`, which independently rewrote profile `runtime.json` files to idle/cancelled state.
- `/api/swarm-runtime/reset` now returns HTTP 409 after authentication, CSRF/content-type, and JSON validation.
- `/api/swarm-missions` remains a read-only legacy history projection and rejects mission/assignment cancellation writes.
- Removed native mission cancellation and runtime reset from Conductor Stop; supported dashboard mission deletion and session cleanup remain available.
- Deleted unused mission/assignment cancellation writer functions from `swarm-missions.ts`.

### Verified

- Twelve focused mission/reset/roster tests pass, including explicit mutation conflicts.
- Production client/SSR build and diff hygiene pass; source search finds no remaining runtime-reset or native cancellation symbols.

## 2026-08-17 — Runtime roster authority neutralized

### Changed

- Retained read-only parsing and presentation helpers for the reviewed `swarm.yaml` registry.
- Removed TypeScript runtime write/upsert functions and changed `/api/swarm-roster` POST to an explicit HTTP 409.
- Reclassified `swarm-checkpoints.ts` as a read-only checkpoint parser/projection rather than a duplicate state authority; its mutation risk belongs to the mission/dispatch consumers.

### Verified

- Two roster schema tests and two route-boundary tests pass.
- The complete Vite client/SSR production build passes after the authority change.

## 2026-08-17 — Legacy Swarm lifecycle authority neutralized

### Changed

- Reduced `swarm-lifecycle.ts` to read-only session-token and handoff-presence telemetry.
- Removed direct process spawning/killing, tmux prompt injection, worker renewal/restart, handoff-memory events, resume prompting, and automatic lifecycle sweeps from the legacy module.
- `/api/swarm-lifecycle` rejects every POST mutation with HTTP 409 and identifies Hermes as the lifecycle owner.

### Verified

- Five route tests prove telemetry remains readable and all four legacy mutation families fail closed.
- Production client/SSR build, regenerated Electron server bundle, locked Rust workspace tests, strict Clippy, installed Core verification, and diff hygiene pass.

## 2026-08-17 — Second duplicate task authority retired

### Changed

- Replaced `kanban-backend.ts` backend detection with one bounded ValKhana Core/Hermes compatibility adapter.
- `/api/swarm-kanban` and `/api/claude-tasks` now read and mutate task lifecycle only through Core; direct SQLite, dashboard-write, and local JSON fallback paths were removed.
- `swarm-kanban-store.ts` is now a read-only legacy migration input and no longer creates, caches, flushes, creates cards, or updates cards.
- Swarm Board presentation now identifies the `ValKhana Core / Hermes` authority, and browser task admission supplies an idempotency identifier.
- Unsupported assignment, manual promotion/running, dependency, mission, criteria, report, tag, and legacy field edits return explicit conflicts rather than disappearing or diverging.

### Verified

- Twenty-five focused adapter, compatibility, projection, and route tests pass.
- The complete locked Rust workspace test suite and strict Clippy pass.
- Vite client and SSR production builds pass, the Electron server bundle was regenerated, and the installed Core health contract remains exact.

## 2026-08-17 — State and event foundations

### Added

- Shared schema-versioned, metadata-first telemetry envelope with documented cross-service correlation identifiers.
- Rust-owned global automation states `ACTIVE`, `PAUSING`, `PAUSED`, `RECOVERY`, and `STOPPED`, explicitly separate from Hermes task status.
- Versioned automation-state persistence at `$VALKHANA_STATE_DIR/policy/automation.json` with exclusive writer locking, atomic replacement, and durable file/directory synchronization.
- Fail-closed `STOPPED` initialization and rejection of unknown persisted schema versions.

### Verified

- Six focused state/event tests pass.
- The complete locked Rust workspace test suite and strict Clippy pass.

## 2026-08-17 — Hermes task-read projection

### Added

- Typed canonical Hermes task statuses and task projection in `valkhana-hermes`.
- Explicit-board `GET /v1/integrations/hermes/tasks?board=<slug>` core endpoint.
- Strict board-slug validation and independent Hermes v0.20.2 compatibility enforcement for board/task reads.

### Verified

- The response shape was checked against the isolated Azure v0.20.2 canary board.
- Adapter and router tests cover typed status projection, explicit board selection, missing queries, and unsafe slugs.
- The installed local service fails closed with HTTP 503 where no supported Hermes CLI is deployed.

## 2026-08-17 — Canonical project mapping

### Added

- Typed parsing of the documented `valkhana.yaml` `project` mapping: project ID, Hermes board slug, absolute repository path, and `worktree`/`scratch` default workspace.
- Startup rejection for unsafe slugs, relative repository paths, malformed mappings, and unknown workspace modes.
- Deterministic configured-board fallback for the task-read endpoint, plus a checked example configuration.

### Verified

- Eleven configuration tests and six core router tests pass, including deterministic mapped-board selection.

## 2026-08-17 — TanStack-to-core server bridge

### Added

- Server-only Node HTTP client for the private ValKhana Core Unix socket.
- Strict path allowlist, absolute socket-path validation, five-second timeout, 64 KiB response bound, JSON validation, and typed upstream errors.

### Verified

- Three focused Unix-socket client tests pass against real temporary socket servers.
- The complete Vite client and SSR production build passes with the bridge included.
- Repository-wide TypeScript checking remains blocked by documented pre-existing errors outside this slice.

## 2026-08-17 — Safe Hermes task admission

### Added

- Configured-board `POST /v1/integrations/hermes/tasks` backed only by the supported Hermes v0.20.2 CLI.
- Required idempotency key, bounded title/body, fixed `valkhana` creator identity, and explicit configured workspace mode.
- Forced Hermes-native `triage` admission with no assignee, promotion, running state, or dispatcher invocation.
- Bounded POST support in the server-side Unix-socket bridge.

### Verified

- Adapter/router tests validate exact CLI arguments, unsafe-key rejection, missing project mapping, and the returned typed task.
- On the isolated Azure board, repeated creation returned the same ID, remained in `triage`, started no worker, and was archived after the probe.
- The live v0.20.2 create JSON shape matches the typed adapter contract.

## 2026-08-17 — First duplicate task authority retired

### Added

- Typed task detail and supported `needs_input` block, request-review, completion, and archive operations in `valkhana-hermes` and Core.
- Read-after-write projection so every successful lifecycle response reflects Hermes' persisted state.
- Compatibility projection from canonical Hermes statuses/priority/timestamps into the existing board DTO.
- Bounded server bridge support for task GET/PATCH/DELETE.

### Changed

- `/api/hermes-tasks` now uses ValKhana Core/Hermes exclusively; it no longer probes or falls back to the local/Claude task authorities.
- `tasks-store.ts` is read-only migration input. All JSON writer functions and missing-file creation were removed.
- Unsupported legacy field edits, dispatcher-owned promotion/running transitions, and local-session worker launch fail explicitly with HTTP 409.
- CLI failures now retain one bounded stderr diagnostic line instead of discarding all command context.

### Verified

- Eight adapter tests, eight core router tests, and ten focused TypeScript bridge/projection/route tests pass.
- The complete Vite client/SSR production build succeeds after the atomic route switch.

## 2026-08-17 — Core daemon foundation

### Added

- Root Cargo workspace with Rust 2024 edition and an explicit Rust 1.85 minimum declaration.
- Initial `valkhana-config`, `valkhana-domain`, `valkhana-events`, and `valkhana-state` library boundaries.
- `valkhana-core` Axum/Tokio daemon.
- Canonical `GET /v1/health` and compatibility `GET /health` routes over an XDG Unix socket.
- Typed health response with the service name, version, and status.
- Strict XDG runtime-path validation with no persistent fallback.
- Exclusive instance lock at `$XDG_RUNTIME_DIR/valkhana/core.lock`.
- Private runtime directory and socket permissions.
- Systemd readiness and stopping notifications.
- Hardened user service with filesystem, device, namespace, syscall, memory, task, CPU, timeout, and restart-rate controls.
- `scripts/valkhana-core-service.sh` with install, update, verify, and uninstall actions.
- Unit tests for configuration path validation and health routing.
- Process-level regression test for private socket permissions, concurrent startup rejection, continued reachability, and graceful cleanup.

### Fixed

- Prevented a second core process from unlinking and replacing the live daemon socket.
- Prevented an older daemon from later removing a newer daemon's socket through split ownership.
- Removed false systemd readiness caused by `Type=simple`; the service now becomes active only after binding succeeds.

### Verified

- Rust workspace tests pass.
- Clippy passes for all workspace targets with warnings denied.
- The installed user service reports active/running.
- `/v1/health` returns the documented JSON.
- `systemd-analyze --user security` reports `2.0 OK`.
- Existing React/Vite production build succeeds.

### Known baseline issues

- The pre-migration TypeScript test suite has one failing API assertion and three Playwright/Vitest collection failures on `main`.
- Frontend production builds report existing large-chunk warnings.

## 2026-08-17 — Tauri health vertical slice

### Added

- Tauri 2 desktop scaffold alongside the existing Electron path.
- `valkhana-api`, a timeout- and size-bounded Unix-socket client for the core health contract.
- Typed `valkhana_core_health` Tauri command.
- Frontend bridge states for web-only, core-online, and core-offline operation.
- Dashboard status surface with periodic React Query health refresh.
- Rust transport tests and focused Vitest bridge coverage.

### Verified

- `cargo test --workspace` and strict workspace Clippy pass.
- All four `valkhana-api` transport tests pass.
- The focused frontend bridge suite passes (3 tests).
- The existing production frontend build succeeds.
- `pnpm tauri build --debug --no-bundle` produces `target/debug/valkhana-desktop`.

## 2026-08-17 — Self-contained Tauri SSR runtime

### Added

- Target-triple Node-compatible SSR companion containing the TanStack server bundle and client assets.
- Trusted Rust-owned companion startup, readiness wait, navigation, log forwarding, and shutdown lifecycle.
- Random per-launch authentication for readiness probes and the localhost browser session.
- Narrow remote capability scope for the development and packaged localhost origins.
- Repeatable `pnpm tauri:sidecar:verify` smoke test.

### Fixed

- Replaced the production dependency on an externally running `127.0.0.1:3000` server.
- Prevented Tauri from trusting an unrelated process merely because it occupies the expected localhost port.

### Verified

- Unauthenticated companion requests return 403.
- The secret readiness handshake, authenticated SSR root, session cookie, and embedded asset request succeed.
- The release Tauri executable starts its companion and the companion exits with the desktop process.
- The Tauri release build and legacy Electron Linux packaging both complete.

## 2026-08-17 — Reproducible Rust toolchain and CI

### Added

- `rust-toolchain.toml` pinning Rust 1.88.0 with Rustfmt and Clippy.
- Dedicated Linux workflow for formatting, locked workspace tests, and strict Clippy with Tauri system dependencies.

### Fixed

- Corrected the declared MSRV from 1.85 to 1.88 after the locked Tauri graph proved that several dependencies require 1.88.

### Verified

- Locked workspace tests and strict Clippy pass locally on Rust 1.88.0.

## 2026-08-17 — TypeScript server ownership audit

### Added

- Complete production-module classification in `SERVER-OWNERSHIP-AUDIT.md`.
- Explicit migration order for UI proxies, Hermes adapters, Rust authorities, and duplicate orchestration.

### Found

- Seven modules maintain competing task, board, assignment, or worker-lifecycle authority and must be delegated to Hermes rather than expanded.
- `kanban-backend.ts` retains a local writable backend and direct SQLite reads that require a pinned, supported Hermes API replacement.

## 2026-08-17 — Hermes deployment contract and read-only adapter

### Added

- `valkhana-hermes`, a bounded read-only integration crate.
- Direct, shell-free Hermes CLI version probing with a five-second timeout and 64 KiB output limit.
- Strict loopback-only HTTP health fallback for deployments that explicitly expose such a surface.
- `GET /v1/integrations/hermes/health` as a status projection in `valkhana-core`; it does not create, update, assign, or dispatch tasks.
- Unit tests for CLI execution, loopback endpoint rejection, bounded HTTP parsing, and the core projection route.

### Deployment evidence

- Azure host `Testpilothermes` runs Hermes Agent `v0.20.0` at commit `f5be9236e00ddf2f2a412697f267078fc4ee068e` from the official NousResearch repository.
- `hermes-gateway.service` is active, while neither the assumed port 8642 nor the dashboard port 9119 is listening. The supported scripting contract on this host is the pinned CLI; the dashboard exposes authenticated APIs only when explicitly started.
- The default Hermes board remained selected and empty during validation.
- Created isolated board `valkhana-canary-20260817` and card `t_e5e0ed10`. The card has no assignee, spawned no worker, and is held with a typed `needs_input` block.

### Found

- An initial-status `blocked` create response was asynchronously promoted to `ready` by the gateway loop. Applying a typed `needs_input` block persisted. Compatibility tests must read state back after every lifecycle mutation.
- Hermes v0.20.0 has no supported first-class transition into its defined `review` column; the supported review/rework convention is a sticky `review-required:` block plus durable comments and explicit unblock.
- The installed test profile dispatched but remained in its model API call until the canary's two-minute timeout. Hermes correctly terminated and circuit-broke the run.
- The native security audit found 19 dependency advisories, including high-severity `aiohttp` and `cryptography` findings. This is a promotion blocker.
- A deliberately nonexistent assignee was skipped without a diagnostic, leaving its card indefinitely `ready`; the canary applied an explicit capability block. This fails the required clear missing-interface/profile behavior.

### Expanded

- Added typed board discovery at `GET /v1/integrations/hermes/boards`.
- Changed CLI output handling from post-hoc size checking to a streaming 64 KiB read bound.
- Added `HERMES-COMPATIBILITY-CANARY.md` as the requirement-by-requirement evidence and promotion ledger.
- Added a validated minimum Hermes version of v0.20.2; older CLI versions and unversioned HTTP fallback probes now project `incompatible` with HTTP 503.

### Candidate qualification

- Installed exact upstream v0.20.2 commit `341d5aebc6f51b8073f6099008e8d24bc74a8b0c` into an isolated Azure checkout, virtual environment, and `HERMES_HOME` without copying live credentials or state.
- Confirmed patched `aiohttp==3.14.3` and `cryptography==50.0.0`; applying the candidate's declared `setuptools==83.0.0` pin produced a zero-finding native audit across 103 components.
- Passed 61 focused upstream tests for review, sticky blocks, diagnostics, boards, and worktree isolation.
- Proved the new first-class `request-review` → `review` → `reopen-review` → `ready` lifecycle with reviewer/implementer routing and structured handoff metadata.
- Confirmed the candidate still promotes create-time blocked cards and silently skips nonexistent profiles, so the live upgrade alone does not close the full canary.
- Verified a real candidate-managed Git worktree and branch through claim, manual reclaim, completion, archive, and cleanup using a disposable repository.
- Verified native candidate backup/restore with a private archive, recorded hash, local recovery destination, restored board counts, and successful SQLite integrity checks.
- Added `HERMES-UPGRADE-RUNBOOK.md` with release-directory switching, backup gates, promotion evidence, immediate rollback, and systemd-hardening criteria.
- Added a guarded compatibility runner that enforces the v0.20.2 floor, zero-finding audit, non-current canary-board isolation, direct bounded CLI calls, dependency and review/rework checks, and a final sticky safety hold.
- Found that candidate `gateway run` rewrites the production user's global gateway unit even with isolated `HERMES_HOME`. Restored the exact original unit and daemon-reloaded it without restarting the live v0.20.0 process; future gateway qualification now requires config-home or OS-user isolation.
- Added a loopback-only deterministic OpenAI-compatible SSE server and synthetic 64K-context configuration for credential-free worker lifecycle testing.
- Proved candidate claim, spawn, heartbeat, lifecycle-tool injection, `kanban_complete`, terminal state, structured metadata, and run/session persistence without external model access or spend.

## 2026-08-17 — XDG-native configuration foundation

### Added

- Canonical XDG derivation for ValKhana config, state, cache, data, and required runtime directories.
- Fail-closed handling for missing or relative `HOME`, XDG roots, and runtime paths.
- Bounded loading for `valkhana.yaml`, `models.yaml`, `routing.yaml`, `permissions.yaml`, and `services.yaml`.
- Required `schema_version: 1` validation for every present configuration document.
- Startup validation in the supervised core before it binds or signals readiness.

### Hardened

- Configuration paths must be absolute and canonical entries must be regular files no larger than 1 MiB.
- Unknown schema versions, malformed YAML, non-string top-level keys, and non-file paths prevent startup.
- Selected maintained `yaml_serde` rather than the deprecated `serde_yaml`/`serde_yml` implementations.

### Verified

- Nine focused configuration/XDG tests pass, including fallbacks, overrides, missing and relative roots, non-UTF-8 runtime paths, canonical file discovery, and invalid schemas.
- The updated installed user service validated an empty canonical config directory, bound its private socket, signaled readiness, and returned the exact health response.
