# Hermes compatibility canary

Last updated: 2026-08-17 UTC
Target host: `Testpilothermes` (`100.98.83.117`, Tailscale only)
Installed Hermes: Agent v0.20.0, commit `f5be9236e00ddf2f2a412697f267078fc4ee068e`
Isolated candidate: Agent v0.20.2, commit `341d5aebc6f51b8073f6099008e8d24bc74a8b0c`
Promotion decision: **NOT READY**

This is the evidence ledger for the v1.3.3 Hermes promotion gate. All mutations use the dedicated `valkhana-canary-20260817` board. The global current board remains `default`, and the default board was empty when testing began.

## Contract matrix

| Contract | State | Evidence / remaining proof |
|---|---|---|
| Exact version and revision | Pass | CLI reports v0.20.0; repository is pinned to the commit above. The vault watchlist identified v0.20.1 as its intended baseline, so the discrepancy remains open. |
| Board discovery | Pass | `hermes kanban boards list --json` returned the default and isolated canary boards with typed counts. `valkhana-hermes` now parses this supported CLI response. |
| Idempotent triage admission | Pass | Two creates with the same key returned `t_c5b78c57`; the task remained `triage`, never dispatched, and was archived. A second probe confirmed the exact v0.20.2 create JSON shape consumed by `valkhana-hermes`. |
| Task creation | Pass with caveat | Idempotent creation works. `--initial-status blocked` is not a durable human gate: dependency recomputation promoted the card to `ready`. |
| Canonical-to-UI status projection | Code pass; deployment pending | Core exposes read-only `/v1/integrations/hermes/boards`; typed parsing and route tests pass. The new core binary is not yet deployed on Azure. |
| Dependency | Pass | Child remained `todo` behind its parent and became `ready` after parent completion. |
| Blocked / human gate | Pass with required sequence | An explicit typed `needs_input` block emitted a sticky `blocked` event and remained blocked. Create-time blocked state alone is unsafe. |
| Approve / deny | Partial | The supported convention is comment + explicit block/unblock. There is no distinct decision object yet; ValKhana must preserve its approval audit record while mapping only the lifecycle effect to Hermes. |
| Review / rework | Installed fail; candidate pass | v0.20.0 has no supported first-class transition. The isolated v0.20.2 candidate adds `request-review`, `request-changes`, and `reopen-review`; a live candidate round trip preserved reviewer/implementer routing, handoff metadata, and the rework reason. |
| Worker dispatch | Pass | Gateway claimed canary `t_1cf4cee8`, created an isolated scratch workspace, spawned PID 3956714, and emitted heartbeats. |
| Successful worker completion | Installed fail; candidate pass | Live `test2` timed out in its provider call. The v0.20.2 candidate completed deterministically against a loopback OpenAI-compatible SSE mock: claim, spawn, heartbeat, `kanban_complete`, `done`, summary, metadata, and session/run history all passed in about one second without credentials or model spend. |
| Timeout / circuit breaker | Pass | The same run was terminated at 121 seconds, recorded `timed_out`, and blocked after one failure as configured. No retry loop occurred. |
| Worktree | Candidate pass | Hermes created a real worktree and branch from a disposable empty Git repository, persisted the resolved path, and removed the worktree after complete/archive. The production checkout was untouched. |
| Crash / heartbeat reclaim | Partial | Live v0.20.0 heartbeat/timeout termination and candidate manual reclaim are proven with run history. Deliberate PID kill followed by automatic stale reclaim remains. |
| Missing profile | **Fail** | Assigned card `t_981a2311` remained `ready`, produced no run and no diagnostic, and was only made safe by an explicit typed capability block. The interface does not surface a clear failure for this required case. |
| Missing provider/model | Partial | Current profile model call timed out and circuit-broke cleanly, but the log only records interruption during the API call. Explicit unavailable-provider/model classification remains. |
| Plugin availability | Pass | Plugin inventory works and reports Kanban as runtime-gated. |
| Missing plugin/interface | Pass | Enabling a deliberately nonexistent canary plugin failed closed with exit code 1 and did not change configuration. |
| Gateway restart | Promotion failed; rollback pass | The authorized live v0.20.2 promotion passed service/runtime gates but Telegram failed with `Any cannot be instantiated` and then stalled connecting. Immediate rollback restored exact v0.20.0 and the prior unit; messaging remains unconfirmed because the old version also stalled at its first Telegram connection attempt. |
| Backup / restore | Live pass | Fresh mode-0600 archive SHA-256 `bc2723a288b93428c57b89ac7d94db23debc459f9a82440a2ed3599e396fb406` restored in isolation with matching DB sizes/task counts and `integrity_check: ok` for state, default, and canary databases. |
| Pause / resume | Not run | The v1.3.3 contract describes a global admission pause. Board-scoped pause is not a supported primitive in this pinned version. |
| `hermes doctor` | Pass with optional warnings | No active advisories, suspicious MCP commands, config errors, or version inconsistencies. Optional integrations are absent as expected. |
| `hermes security audit` | Installed fail; candidate pass | v0.20.0 has 19 findings including high severity. The isolated v0.20.2 candidate pins patched `aiohttp==3.14.3` and `cryptography==50.0.0`; after applying its declared `setuptools==83.0.0` build/dev pin, the audit scanned 103 components with zero findings. |
| Candidate upstream tests | Pass | 61 focused tests covering first-class review, review completion/rework, sticky blocking, diagnostics, boards, and worktree isolation passed on exact commit `341d5ae`. |
| Repeatable guarded runner | Pass | `scripts/hermes-compat-canary.py` passed twice against the isolated candidate, covering version floor, zero-finding audit, board discovery, dependency, sticky block, first-class review, and rework. It rejected live v0.20.0 before mutation. |

## Confirmed adapter boundary

- Preferred deployment contract: the exact absolute Hermes CLI path, invoked directly without a shell.
- Health probe: `hermes --version` with a five-second timeout and a true streaming 64 KiB output bound. Versions below the validated v0.20.2 floor return `incompatible`, not `connected`.
- Board discovery: `hermes kanban boards list --json`, parsed into a narrow typed projection.
- HTTP fallback: loopback-only, credential-free origin; it is health-only and cannot claim board support.
- No ValKhana component may write Hermes SQLite tables directly.
- No create, assign, claim, dispatch, block, or complete capability is exposed through the read-only core routes.

## Promotion blockers

Exact isolated v0.20.2 gateway probes now load Telegram through the plugin-manager alias with real SDK classes and reach Telegram both with and without fallback-IP transport; a fake token is rejected normally in under one second. The prior `Any cannot be instantiated` error is not reproducible. Live real-token/configuration messaging health remains the promotion blocker.

1. Promote only through a rollback-safe upgrade from the dirty live v0.20.0 checkout to the qualified v0.20.2 candidate; do not update in place.
2. Ensure the installed environment applies `setuptools==83.0.0`, then reproduce the zero-finding audit after upgrade.
3. Establish a functioning test worker profile and prove clean lifecycle completion.
4. Add or require a supported diagnostic for nonexistent profiles; both versions silently leave these cards `ready`.
5. Complete deliberate crash/automatic reclaim, gateway restart, live backup/restore, and global pause/resume drills.
6. Diagnose and prove Telegram/plugin-loader startup in isolation, then repeat the rollback-safe promotion procedure in [`HERMES-UPGRADE-RUNBOOK.md`](HERMES-UPGRADE-RUNBOOK.md). The first authorized attempt rolled back cleanly.

The candidate code path has clean deterministic completion evidence. Item 3 remains a live-deployment gate because the actual configured provider/profile must also complete after promotion.

## Safety invariants

- Never switch the server's global current board during a canary.
- Never run a canary against `default` or a production project checkout.
- Keep canary cards unassigned until the intended dispatch test begins.
- Give every worker canary a runtime cap and one-attempt circuit breaker.
- Read state back after every mutation; command success is not durable-state proof.
- Do not restart the live gateway or restore state without an announced maintenance window and a verified rollback artifact.
- Do not run a candidate gateway under the production OS user with only `HERMES_HOME` isolation; Hermes may rewrite the global user service.
- Use `scripts/hermes-compat-canary.py` read-only by default. Its lifecycle mode refuses the globally current board and any board without a ValKhana canary prefix, never invokes a dispatcher pass, and leaves the final child explicitly blocked.
- Use `scripts/hermes-openai-canary-server.py` only on loopback with `docs/valkhana/hermes-canary-config.yaml` and a fully isolated home/config root. It provides deterministic SSE responses and calls only the injected `kanban_complete` tool.
