# ValKhana v1.3.3 build status

Last updated: 2026-08-30 UTC
Branch: `architecture/valkhana-v1.3.3`
Base checkpoint: `03a7cd39` (`main`)
Recovery branch: `snapshot/pre-valkhana-v1.3.3-20260816`

This is the canonical continuation checklist for the v1.3.3 architecture migration. Update it whenever a build slice changes state.

Quality gate: the completed migration scope scores **96/100** in [`QUALITY-SCORECARD.md`](QUALITY-SCORECARD.md), above the required 92, including a verified GitHub clean-checkout CI run.

Last material update: 2026-08-30 UTC — see [`EVENT-TELEMETRY-PRIVACY.md`](EVENT-TELEMETRY-PRIVACY.md) for the event-journal boundary and current retention/redaction limits.

## Current milestone

Build the first vertical slice without replacing the existing React application:

```text
existing UI → Tauri 2 → valkhana-core → Unix socket health API
```

The Rust core, supervised health API, Tauri command bridge, dashboard status surface, production SSR companion, read-only Hermes adapter, versioned configuration, and first state/event foundations are working. The active focus is incremental server-authority migration.

## Done and verified

- [x] Preserve the existing `Hurbur/Valkhana-workspace` repository.
- [x] Baseline `main` at `03a7cd39`.
- [x] Create recovery branch `snapshot/pre-valkhana-v1.3.3-20260816`.
- [x] Create migration branch `architecture/valkhana-v1.3.3`.
- [x] Install Rust and add the root Cargo workspace.
- [x] Add initial library crates:
  - `valkhana-config`
  - `valkhana-domain`
  - `valkhana-events`
  - `valkhana-state`
- [x] Add the `valkhana-core` daemon.
- [x] Require `$XDG_RUNTIME_DIR`; do not fall back to persistent storage.
- [x] Serve canonical `GET /v1/health` and compatibility `GET /health` over `$XDG_RUNTIME_DIR/valkhana/core.sock`.
- [x] Return the documented health payload for version `0.1.0`.
- [x] Enforce runtime directory mode `0700` and socket mode `0600`.
- [x] Enforce single-instance ownership with an exclusive runtime lock.
- [x] Reject a second daemon without replacing the live socket.
- [x] Clean up the socket on graceful SIGTERM shutdown.
- [x] Add unit tests for XDG path validation and derivation.
- [x] Add router tests for both health paths, exact JSON, invalid routes, and invalid methods.
- [x] Add a process-level Unix socket lifecycle/concurrency test.
- [x] Add a hardened `systemd --user` service.
- [x] Add systemd readiness notification (`Type=notify`).
- [x] Add memory, task, CPU, timeout, and restart-rate controls.
- [x] Declare a private systemd-managed XDG state directory so the policy SQLite ledger remains writable under `ProtectHome=read-only` and `ProtectSystem=strict`.
- [x] Add repeatable `install`, `update`, `verify`, and `uninstall` service commands.
- [x] Verify `cargo test --workspace` passes.
- [x] Verify Clippy passes with warnings denied.
- [x] Verify the installed service is active and the canonical health endpoint responds.
- [x] Run `systemd-analyze --user security`; current exposure score is `2.0 OK`.
- [x] Restore the TypeScript release gate: aligned the patched TanStack Start/Router line, corrected remaining local application/test contracts, and separated Cloudflare-worker checking. Both TypeScript projects typecheck cleanly; the full 149-file/865-test Vitest suite and production build pass.
- [~] **Deferred by operator:** live Telegram/platform-health confirmation and any Hermes v0.20.2 promotion. Keep the verified rollback/canary evidence; do not touch the live deployment without a newly authorized maintenance window.
- [ ] **Deployment environment unavailable:** the Azure VM used for prior ValKhana/Hermes evidence has been sunsetted. The intended AWS replacement is not implemented or running, so no live deployment, canary, promotion, recovery validation, or end-to-end Hermes verification may be claimed or attempted until a reviewed target exists.
- [x] Add a Tauri 2 desktop target beside Electron.
- [x] Add a bounded, typed Unix-socket client in `valkhana-api`.
- [x] Expose `valkhana_core_health` through the Tauri command bridge.
- [x] Add explicit web, online, and offline frontend health states.
- [x] Add a live ValKhana Core status element to the existing dashboard.
- [x] Add frontend bridge tests for web mode, healthy responses, command failures, and malformed responses.
- [x] Add transport tests for valid health, non-200 responses, invalid JSON, wrong service identity, and oversized responses.
- [x] Verify a real Tauri debug build (`--no-bundle`) succeeds.
- [x] Pin the workspace to its proven Rust 1.88.0 MSRV.
- [x] Verify tests and strict Clippy under the pinned MSRV.
- [x] Repair dedicated Linux Rust CI so a clean checkout installs locked Node dependencies and reproducibly prepares the ignored Tauri sidecar before Cargo. GitHub run `33343179153` passed formatting, locked workspace tests, and strict Clippy.
- [x] Package TanStack Start SSR and client assets into a target-triple Tauri sidecar.
- [x] Manage the sidecar lifecycle from trusted Rust code without webview shell permissions.
- [x] Authenticate sidecar readiness and web sessions with a random per-launch token.
- [x] Add a repeatable sidecar verification script.
- [x] Verify the Tauri release build and live sidecar lifecycle.
- [x] Verify the legacy Electron Linux packaging path still completes.
- [x] Classify every production `src/server` module by target ownership.
- [x] Identify and freeze duplicate task/lifecycle authorities for migration-only changes.
- [x] Pin the deployed Hermes Agent version and exact source revision.
- [x] Confirm the deployed Hermes gateway and dashboard runtime surfaces without reading or changing secrets.
- [x] Add a bounded, read-only `valkhana-hermes` adapter that prefers the supported CLI contract.
- [x] Project Hermes availability through `GET /v1/integrations/hermes/health` without taking task authority.
- [x] Create an isolated Azure Hermes canary board without switching or modifying the default board.
- [x] Add typed read-only board discovery through `GET /v1/integrations/hermes/boards`.
- [x] Add typed, explicit-board task discovery through `GET /v1/integrations/hermes/tasks?board=<slug>`.
- [x] Add idempotent, configured-board task admission through `POST /v1/integrations/hermes/tasks`; new tasks are forced into Hermes-native `triage` and cannot dispatch on creation.
- [x] Add configured-board task detail plus supported human block, request-review, complete, and archive transitions through ValKhana Core.
- [x] Atomically redirect `/api/hermes-tasks` reads and supported writes to Core/Hermes and remove automatic local/Claude task-backend probing.
- [x] Make legacy `~/.hermes/tasks.json` a read-only migration input by deleting its writer functions and missing-file creation.
- [x] Redirect `/api/swarm-kanban` and `/api/claude-tasks` through the same Core/Hermes adapter, eliminating direct Hermes SQLite writes and writable local-board fallback.
- [x] Make `~/.hermes/swarm2-kanban.json` a read-only migration input by deleting its writer functions, cache/flush path, and missing-file creation.
- [x] Reduce `swarm-lifecycle.ts` to read-only context telemetry and reject legacy prompt injection, handoff, renewal, restart, and automatic sweep mutations as Hermes-owned.
- [x] Make the runtime Swarm roster API read-only and remove its TypeScript YAML writer/upsert path; reviewed registry configuration remains readable by presentation consumers.
- [x] Delete the shadow `runtime.json` reset authority, reject `/api/swarm-runtime/reset` with HTTP 409, and remove native mission/assignment cancellation writes from public routes.
- [x] Retire legacy Swarm dispatch, orchestrator-loop, and checkpoint-write authority; all three authenticated mutation routes now return explicit Core/Hermes conflicts.
- [x] Remove Conductor's native process/tmux fallback while preserving the supported dashboard Conductor API and read-only legacy mission history.
- [x] Reduce `swarm-missions.ts` to a read-only migration projection and delete its mission, assignment, checkpoint, review, continuation, and stale-archive writers.
- [x] Prove dependency promotion, explicit sticky human gates, worker claim/spawn/heartbeat, timeout termination, and one-attempt circuit breaking on the isolated board.
- [x] Run Hermes doctor, plugin inventory, missing-plugin failure, and the native security audit.
- [x] Implement the complete XDG directory contract for config, state, cache, data, and runtime roots.
- [x] Load and validate all five canonical versioned YAML configuration documents at core startup.
- [x] Parse and validate the documented `project` mapping from `valkhana.yaml`, including its canonical Hermes board, absolute repository, and default workspace mode.
- [x] Add a bounded, allowlisted server-side Unix-socket client for TanStack routes to call ValKhana Core without exposing generic socket access to the browser.
- [x] Define the shared schema-versioned, metadata-first telemetry envelope.
- [x] Add a bounded 24-hour/10,000-record in-memory Core event journal, metadata allowlist/redaction count, private read-only `GET /v1/events`, manual in-process purge, and post-durable-policy-decision projection.
- [x] Persist Rust-owned global automation state under the XDG state policy directory with an exclusive writer lock and atomic replacement.
- [x] Fail closed to `STOPPED` when automation state has not been initialized.
- [x] Add the Rust-owned `valkhana-policy` decision foundation with typed allow/deny/require-approval outcomes and exact, expiring task/project/capability/target grants.
- [x] Add the bounded `valkhana-components` trusted-registry foundation; only approved registered non-model components can be selected autonomously, while model trust remains solely in `models.yaml`.
- [x] Parse typed `permissions.yaml` agent profiles at Core startup, accept only the documented profile vocabulary, and prohibit persistent `admin`.
- [x] Add a private schema-versioned SQLite policy decision ledger under the XDG state root with strict bounded values, append-only record IDs, and newest-first reads; initialize it before Core readiness.
- [x] Add the Core-owned policy evaluation service and private `GET`/`POST /v1/policy/decisions` contract; persist every returned decision and accept no caller-asserted grant or approval identifier.
- [x] Persist server-owned approval states and exact task/project/capability/target grants with automatic expiry, immediate revocation, a 24-hour maximum, pending-request deduplication, and read-only Core approval endpoints.
- [x] Enforce the first action PEP at Hermes task admission: Core authorizes the narrow built-in `service:valkhana` capability, persists the decision before execution, correlates it with the idempotency key, and fails closed before invoking Hermes when policy is unavailable.
- [x] Extend the same pre-execution PEP to fail-safe `needs_input` blocking and request-review transitions with distinct task-scoped capabilities and audit records.
- [x] Validate the optional canonical `$VALKHANA_DATA_DIR/components/registry.yaml` before Core readiness and fail closed on malformed registered state.
- [x] Implement the ValKhana-owned Linux Secret Service/KWallet backend with encrypted transfer, exact namespace attributes, no plaintext fallback, locked-store fail-closed behavior, zeroized values, and a disposable live lifecycle drill.
- [x] Provision the dashboard-owned service key and enforce versioned, payload-bound HMAC proofs with timestamps and restart-safe one-use nonce digests on complete/archive; verify negative cases, a router-restart regression, and a live signed installed-Core probe.
- [x] Give packaged Linux Electron the same Secret Service boundary through a native exec launcher; prove valid-key startup, unavailable-session-bus degradation, inherited-token removal, protected-action 503 behavior, and AppImage embedding.
- [x] Implement and live-prove five-minute dashboard-key rotation overlap, previous-key verification/finalization, marker-first emergency revocation, and safe reprovisioning with no credential export.
- [x] Prove locked-wallet fail-closed behavior in a disposable isolated D-Bus/home/XDG/GNOME Secret Service session without touching or unlocking the real KDE wallet.
- [x] Implement typed, validated Hermes v0.20.2 adapter support for assignment, dependency link/unlink, non-forced promotion, reclaim/reassign, request-changes, and reopen-review, with read-back verification.
- [x] Expose those higher-impact mutations only through dashboard-service HMAC authentication followed by high-risk Core policy evaluation; bind approval scope to the exact payload digest, deduplicate pending requests, and prove Hermes is not invoked before an exact server-owned human grant.
- [x] Document why service possession and human authorization are distinct; do not treat a same-session keyring token as proof of human presence.

## Working now

- `valkhana-core.service` starts automatically in the user's systemd manager.
- Core readiness is reported only after the socket is bound and permissions are applied.
- Health response:

  ```json
  {"name":"valkhana-core","version":"0.1.0","status":"healthy"}
  ```

- Service management:

  ```bash
  scripts/valkhana-core-service.sh install
  scripts/valkhana-core-service.sh update
  scripts/valkhana-core-service.sh verify
  scripts/valkhana-core-service.sh uninstall
  ```

## Current issues

- The existing TypeScript test baseline is not green on untouched `main`:
  - 140 test files pass.
  - 852 tests pass.
  - `src/routes/api/-hermes-config.test.ts` has one provider assertion failure.
  - Three Playwright specifications under `e2e/` are incorrectly collected by Vitest.
- The repository-wide `tsc --noEmit` baseline is also not green and reports pre-existing Cloudflare worker globals, router typing, playground/Three.js typing, and legacy swarm typing errors. The new core client focused tests and production build pass.
- The production frontend build succeeds but reports large chunk warnings.
- A historical GitHub clean-checkout Rust run failed before tests because Tauri's ignored generated sidecar was absent. The workflow now runs locked dependency installation and `pnpm tauri:prepare` before Cargo; GitHub run `33343179153` confirms formatting, locked workspace tests, and strict Clippy pass from a clean checkout.
- `valkhana-events` and `valkhana-state` now include a bounded metadata-only Core event projection. It deliberately clears on Core restart; the private policy SQLite ledger remains durable. Configurable/per-project retention, journald/SSE/export sinks, aggregation, and global control/transition enforcement remain later slices.
- The server bundler emits existing `import.meta` and tree-shaking warnings; runtime SSR and embedded asset smoke tests pass despite them.
- Historical Azure evidence: the former Azure Hermes gateway did not expose the previously assumed unauthenticated HTTP health endpoint on port 8642. The read-only adapter therefore uses the exact deployed CLI by default and retains loopback HTTP only as an explicitly bounded fallback. That VM is now sunsetted; this is not a current deployment capability.
- Hermes Agent `v0.20.0` immediately promoted a newly created, unassigned canary card from `blocked` to `ready`; a typed `needs_input` block remained stable. No worker was spawned. Callers must verify post-mutation state instead of trusting the create response as durable lifecycle state.
- The controlled worker canary dispatched correctly but its configured model call did not return before the two-minute cap. Hermes terminated it and blocked the card after the configured single attempt; successful completion is not yet proven.
- Live v0.20.0 still has 19 dependency findings. The v0.20.2 candidate has zero findings, but its authorized promotion was rolled back because Telegram failed to initialize and then stalled connecting.
- The pinned version has a `review` database state and dispatcher path but no supported first-class transition into it. Current official guidance uses `review-required:` blocking and comment/unblock rework instead.
- A card assigned to a nonexistent profile remained silently `ready` with no run or diagnostic. It was explicitly capability-blocked after the probe. Clear missing-profile failure behavior is another promotion blocker.
- An isolated Hermes v0.20.2 candidate at `341d5aebc6f51b8073f6099008e8d24bc74a8b0c` removes the high-severity dependency findings and supplies first-class review/rework transitions. Its focused upstream Kanban suite passed 61 tests, but it retains create-time blocked promotion and silent missing-profile behavior.
- The core now rejects Hermes versions below v0.20.2, and treats unversioned HTTP fallback health as incompatible rather than connected.
- Board and task reads independently enforce the v0.20.2 compatibility floor; they cannot bypass a failed health check. Task reads use either an explicit validated board slug or the validated project mapping and never rely on mutable current-board selection.
- Task admission requires a configured project mapping and caller-supplied idempotency key, applies the configured `worktree`/`scratch` mode, fixes `created_by` to `valkhana`, and exposes no assignee or initial-running control.
- The v0.20.2 candidate passed real isolated worktree create/claim/reclaim/complete/archive cleanup and a hashed mode-0600 native backup/restore drill with SQLite integrity checks.
- The authorized release-switch promotion proved the reviewed v0.20.2 unit and reduced systemd exposure, but Telegram did not become healthy. Immediate rollback restored exact v0.20.0 and its prior unit; the immutable release layout and verified backup remain available for the next attempt.
- `scripts/hermes-compat-canary.py` now makes the safe promotion checks repeatable. It passed twice against the isolated candidate and rejected the live v0.20.0 CLI before any mutation.
- Candidate gateway startup proved that `HERMES_HOME` does not isolate Hermes' systemd unit management. The candidate rewrote the on-disk live unit; the exact original was restored and daemon-reloaded, and the live v0.20.0 PID remained uninterrupted. Further gateway drills require `XDG_CONFIG_HOME` isolation or another OS user/VM.
- Candidate worker completion now has deterministic end-to-end proof through a loopback OpenAI-compatible SSE mock: the worker claimed, spawned, heartbeated, invoked `kanban_complete`, persisted structured metadata, and reached `done` in about one second. The live `test2` provider remains unqualified because its earlier call timed out.
- Legacy task title/body/priority/assignee/session edits, manual promotion to Ready/Running, and local-session launch now return explicit HTTP 409 responses. Equivalent supported Hermes commands and policy/automation gates must be implemented before those controls are re-enabled.
- The Swarm Board and Claude Tasks compatibility surfaces now share that same fail-closed behavior. Their old direct-SQL, dashboard-write, and writable JSON backends are unreachable; only Core-backed triage admission and supported block/review/complete transitions remain.
- `/api/swarm-lifecycle` GET remains available for read-only token/context telemetry. Every legacy POST action now returns HTTP 409; process spawning, tmux prompt injection, worker killing/restart, handoff-memory mutation, and auto-sweep code were removed from the module.
- `/api/swarm-roster` GET remains available for presentation metadata, while POST returns HTTP 409. `swarm-roster.ts` no longer writes `swarm.yaml`; registry authority must move through the reviewed ValKhana configuration path.
- Legacy mission history remains readable, but `/api/swarm-missions` mutation returns HTTP 409. Conductor Stop retains supported dashboard/session cleanup only; it no longer cancels the native mission store or rewrites worker runtime files.
- Legacy dispatch, orchestrator-loop continuation, and checkpoint-write routes now return HTTP 409. Conductor no longer launches a native fallback when its supported dashboard API is unavailable, and the mission-store module has no write functions.
- The installed local core has neither a configured `project` mapping nor a compatible local Hermes CLI. The migrated task routes therefore fail closed locally; end-to-end task UI verification requires the isolated candidate environment or a reviewed Hermes promotion/configuration.
- Exact isolated v0.20.2 gateway probes loaded Telegram through the real `hermes_plugins.telegram_platform` alias, constructed the real `HTTPXRequest`, completed fallback-IP discovery, and received an expected fake-token rejection in under one second. The earlier `Any cannot be instantiated` is not reproducible; the remaining messaging blocker is specific to the live real-token/configuration path.
- The parallel Rust suite exposed transient Linux `ETXTBSY` when immediately re-executing a test CLI. The bounded Hermes runner now retries only that specific spawn condition three times at 10 ms; two consecutive full workspace runs pass.
- The first policy-enabled live update exposed a missing systemd write exception for `$XDG_STATE_HOME/valkhana`; `StateDirectory=valkhana` now creates only that private writable root under the otherwise read-only home sandbox. The repaired service is active, exact health passes, state/policy modes are `0700`, the database is `0600`, SQLite integrity is `ok`, and exposure remains `2.0 OK`.
- Secret Service protects ValKhana-owned credentials at rest and in transit, but the freedesktop contract does not guarantee per-application authorization inside one unlocked login session. Linux Tauri/Electron SSR/Core service authentication and bounded rotation/revocation are implemented within that documented residual-risk boundary; macOS/Windows handoff and stronger same-user isolation remain. Human approval still requires a separate Hermes-native or OS-mediated user-presence bridge.

## Open questions

- Should the compatibility `/health` route remain through v1, or receive an explicit removal milestone after all clients use `/v1/health`?
- Should later releases adopt systemd socket activation, or retain the current daemon-owned socket plus exclusive lock?
- Should the fixed desktop SSR port remain `3847`, or move to a dynamically allocated port in a later hardening pass? The current per-launch authentication prevents trusting an unrelated listener.
- What CI platforms must validate the Rust workspace and Tauri build first: Linux only, or Linux/Windows from the first Tauri commit?

## Open items: immediate next slice

- [x] Add Tauri 2 beside Electron; do not remove Electron yet.
- [x] Define the minimal Tauri command that reads `/v1/health` through the Unix socket.
- [x] Expose a typed frontend health model with explicit offline/degraded states.
- [x] Add a ValKhana Core status element to the existing dashboard.
- [x] Add UI/transport tests for online, offline, malformed-response, and bounded-response behavior.
- [x] Choose and implement the production TanStack Start packaging strategy for Tauri.
- [ ] Exercise the packaged desktop UI against a running core and verify offline recovery visibly.
- [x] Verify Electron legacy mode continues building alongside the Tauri target.
- [x] Trace consumers of the seven duplicate-orchestration modules.
- [x] Pin the installed Hermes version and identify its supported Kanban/task API.
- [x] Build the first read-only `valkhana-hermes` health/status adapter.
- [x] Add Linux CI for Cargo formatting, tests, Clippy, and the process-level socket test.
- [x] Pin and verify the supported Rust 1.88.0 MSRV.

## Later build phases

- [x] Implement configuration loading with schema versions and XDG config paths.
- [x] Implement authoritative state and event foundations.
- [x] Implement the first policy and component-registry crates, typed profile parsing, Core startup validation, decision ledger, evaluation/audit API, approval/grant lifecycle, and triage/block/review PEPs. Authenticated human approval mutation, complete/archive and external PEP enforcement, and registry inventory remain.
- [ ] Complete the Hermes adapter without direct Hermes SQLite writes. Health, boards, task reads, safe triage admission, manual lifecycle, assignment, dependency, non-forced promotion, reclaim/reassign, and review-rework commands are implemented internally; policy-gated Core exposure and worker claim/dispatch contracts remain.
- [ ] Resolve every blocker and remaining case in [`HERMES-COMPATIBILITY-CANARY.md`](HERMES-COMPATIBILITY-CANARY.md); do not promote the current Hermes build while its security audit fails.
- [ ] Audit every `src/server` responsibility and classify it as UI proxy, Hermes adapter, Rust authority, or duplicate orchestration.
- [ ] Migrate authority and policy responsibilities from TypeScript to Rust incrementally.
- [ ] Implement model gateway and model manager.
- [ ] Add configurable Claude and Codex external-worker adapters through Hermes lifecycle authority.
- [ ] Add recovery, configurable/streaming telemetry and degraded-mode behavior; the bounded event projection and durable policy audit are implemented, but they are not a complete telemetry system.
- [ ] Add version-aware Hyprland integration only after core/Hermes/model foundations.
- [ ] Remove Electron only after measured Tauri feature parity.
- [ ] Complete every applicable v1.3.3 master-checklist phase and run a requirement-by-requirement completion audit.

## Resume procedure

1. Open this file and `docs/valkhana/CHANGELOG.md`.
2. Read the v1.3.3 documents in the Dr. Doom vault under `Notes/Projects/Valkhana/`.
3. Confirm the current branch and working tree with `git status --short --branch`.
4. Run:

   ```bash
   scripts/valkhana-core-service.sh verify
   cargo test --workspace
   cargo clippy --workspace --all-targets -- -D warnings
   pnpm build
   ```

5. Continue from the first unchecked item in **Open items: immediate next slice**.
