# `src/server` ownership audit

Last audited: 2026-08-17 UTC
Scope: all 84 production files under `src/server` (tests excluded)
Architecture rule: Hermes owns task lifecycle, dispatch, workspaces/worktrees, review, heartbeat/reclaim, and worker lanes. ValKhana owns UI, policy, and model-resource control.

This is a migration classification, not permission to rewrite all modules at once. Existing behavior remains available while each route is redirected to its target authority and covered by compatibility tests.

## 1. UI proxy / API aggregation — keep thin in TypeScript or move behind Tauri

These modules may remain as presentation adapters while the existing TanStack server is packaged. They must not become canonical stores or policy authorities.

- `auth-middleware.ts`
- `chat-backends.ts`
- `chat-event-bus.ts`
- `chat-mode.ts`
- `conductor-mission-sanitize.ts`
- `context-usage.ts`
- `dashboard-aggregator.ts`
- `external-memory-browser.ts`
- `gateway-capabilities.ts`
- `integration-detection.ts`
- `knowledge-browser.ts`
- `local-session-store.ts`
- `memory-browser.ts`
- `plugins-browser.ts`
- `portable-history.ts`
- `profiles-browser.ts`
- `provider-usage.ts`
- `pty-helper.py`
- `rate-limit.ts`
- `run-store.ts`
- `send-run-tracker.ts`
- `session-utils.ts`
- `stt-transcription.ts`
- `swarm-chat-reader.ts`
- `swarm-checkpoints.ts` (read-only parser/projection; mission consumers remain migration targets)
- `swarm-environment.ts`
- `swarm-notifications.ts`
- `tailscale-cgnat.ts`
- `terminal-sessions.ts`
- `tool-artifacts-store.ts`
- `update-system.ts`
- `valkhana-dashboard-adapter.ts`
- `valkhana-gateway-ws.ts`
- `valkhana-handoff-status.ts`
- `valkhana-session-snapshot.ts`
- `valkhana-tailnet.ts`
- `workspace-state-dir.ts`

## 2. Hermes integration — converge on `valkhana-hermes`

These are external-system adapters. Reads and supported Hermes API calls are appropriate; direct Hermes SQLite writes and competing lifecycle decisions are not.

- `claude-agent.ts`
- `claude-api.ts`
- `claude-dashboard-api.ts`
- `claude-paths.ts`
- `claude-tasks-backend.ts`
- `hermes-config-migration.ts`
- `hermes-config-route.ts`
- `hermes-config-store.ts`
- `hermes-cron-profiles.ts`
- `kanban-backend.ts`
- `kanban-dashboard-proxy.ts`
- `swarm-profile-config.ts`

## 3. ValKhana authority / policy — move to the Rust control plane

These encode trusted registry, security, model routing, profile, naming, handoff, or session policy. TypeScript may keep DTO/projection code, but authoritative decisions belong in Rust.

- `gateway.ts`
- `knowledge-config.ts`
- `local-provider-discovery.ts`
- `mcp-cli-bridge.ts`
- `mcp-hub-sources-store.ts`
- `mcp-hub/cache.ts`
- `mcp-hub/index.ts`
- `mcp-hub/lib/ssrf-guard.ts`
- `mcp-hub/sources/generic-json.ts`
- `mcp-hub/sources/local-file.ts`
- `mcp-hub/sources/mcp-get.ts`
- `mcp-hub/trust.ts`
- `mcp-hub/types.ts`
- `mcp-input-validate.ts`
- `mcp-normalize.ts`
- `mcp-presets-store.ts`
- `mcp-tools-cache.ts`
- `name-reservations.ts`
- `openai-compat-api.ts`
- `responses-api.ts`
- `swarm-foundation.ts` (schemas/projections only may remain in TypeScript)
- `swarm-memory.ts`
- `swarm-mode.ts`
- `swarm-model-resolver.ts`
- `valkhana-handoff-auth.ts`
- `valkhana-handoff-service.ts`
- `valkhana-profile-store.ts`
- `valkhana-session-organizer.ts`
- `valkhana-session-service.ts`

## 4. Duplicate agent orchestration — remove or delegate to Hermes

These currently create a competing lifecycle, task store, dispatcher, assignment history, worker restart path, or board authority. They are frozen for new architecture work except compatibility fixes required to migrate consumers.

- `swarm-kanban-store.ts`
- `swarm-lifecycle.ts`
- `swarm-missions.ts`
- `swarm-roster.ts`
- `swarm-runtime-reset.ts`
- `tasks-store.ts`

## Critical findings

1. `tasks-store.ts` is a standalone JSON task authority with create/update/move/delete operations. It conflicts directly with Hermes canonical task ownership.
2. `swarm-kanban-store.ts` maintains another writable Kanban history at `~/.hermes/swarm2-kanban.json`.
3. `swarm-missions.ts` derives mission/assignment state, dispatch markers, review completion, blocking, cancellation, and continuation in a separate JSON store.
4. `swarm-lifecycle.ts` sends prompts, starts/stops workers, requests handoffs, renews workers, and performs automatic lifecycle sweeps outside Hermes lifecycle authority.
5. `kanban-backend.ts` supports a `local` writable backend and direct SQLite reads. The target must be a version-pinned Hermes adapter using supported APIs; no direct Hermes SQLite writes are permitted.

## Duplicate-authority consumer trace

| Authority module | Production consumers | Compatibility behavior to preserve through Hermes |
|---|---|---|
| `tasks-store.ts` | No production runtime consumer; types/read-only importer only | **Writer migration complete.** `/api/hermes-tasks` now uses Core/Hermes for reads, triage admission, detail, block, review, completion, and archive. Unsupported legacy edits fail explicitly. |
| `swarm-kanban-store.ts` | Type-only DTO importer; legacy read function has no production consumer | **Writer migration complete.** `/api/swarm-kanban` and `/api/claude-tasks` use Core/Hermes only; the JSON file remains read-only migration input. |
| `swarm-checkpoints.ts` | conductor spawn, swarm dispatch, orchestrator loop; memory/mission/notification helpers | **Read-only parser, not an authority by itself.** Mission/dispatch consumers that turn parsed checkpoints into lifecycle state remain migration targets. |
| `swarm-missions.ts` | conductor spawn/stop; swarm dispatch, missions, orchestrator loop, reports | Mission creation, assignment dispatch, block/review/cancel/continuation state. This is the largest competing task-history surface. |
| `swarm-roster.ts` | crew status, checkpoint, direct chat, dispatch, health, lifecycle, orchestrator, roster, runtime, tmux-start | **Runtime writer neutralized.** Static presentation reads remain; `/api/swarm-roster` POST returns 409 and TypeScript YAML write/upsert functions are removed. |
| `swarm-lifecycle.ts` | `/api/swarm-lifecycle` | **Mutation authority neutralized.** GET retains read-only context telemetry; all prompt/restart/renew/handoff/auto-sweep POST actions return 409 and their implementation was removed. |
| `swarm-runtime-reset.ts` | No remaining consumer; module deleted | **Authority removed.** The endpoint returns 409, mission cancellation no longer invokes it, and Conductor Stop retains only supported external cleanup. |

High-risk route entry points are `/api/conductor-spawn`, `/api/conductor-stop`, `/api/swarm-dispatch`, `/api/swarm-orchestrator-loop`, `/api/swarm-lifecycle`, `/api/swarm-missions`, `/api/swarm-checkpoint`, `/api/swarm-direct-chat`, `/api/swarm-tmux-start`, `/api/swarm-runtime/reset`, and both `/api/hermes-tasks` routes. New product work must not add dependencies on these mutation paths while authority migration is underway.

## Migration order

1. ~~Trace routes/importers for the seven duplicate-orchestration modules and record user-visible behaviors that require compatibility.~~ Complete above.
2. Pin and canary the supported Hermes Kanban/task API before changing authority.
3. Introduce the `valkhana-hermes` Rust adapter with read-only health/status first.
4. Redirect task/board reads to Hermes projections. **Complete for `/api/hermes-tasks`, `/api/swarm-kanban`, and `/api/claude-tasks`; mission/checkpoint projections remain.**
5. Redirect create/update/review/lifecycle operations to supported Hermes commands behind policy gates. **Triage admission, block, review, complete, and archive complete across task/board compatibility surfaces; assignment/promotion/reclaim/dispatch remain.**
6. Make local task/swarm stores read-only migration inputs, then remove their writers. **`tasks-store.ts` and `swarm-kanban-store.ts` complete; mission/checkpoint/roster/runtime stores remain.**
7. Delete duplicate lifecycle and dispatcher paths only after canary coverage proves create, dependency, worktree, block, approve/deny, review/rework, crash/reclaim, pause/resume, backup/restore, and gateway restart behavior.

## Gate status

- Classification: **complete**
- Authority migration: **in progress — task, Kanban, lifecycle, roster, runtime-reset, and cancellation authorities retired/neutralized; mission creation/dispatch/checkpoint/review writers remain**
- Safe to remove Electron: **no**
- Safe to claim Hermes compatibility: **no**
