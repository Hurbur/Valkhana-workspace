# ValKhana implementation review — 2026-08-30

## Scope and method

This review covered the current worktree, the Bootstrap remediation addendum,
the retained-fleet verifier, the Python codex-shim runtime, the TypeScript API
and authority adapters, the Rust Core/policy/Hermes crates, systemd units, the
Tauri/SSR sidecar, and dependency configuration. The original 2026-08-29 brief
was treated as the scope baseline and preserved unchanged.

The review was performed in successive rounds:

1. Inventory and diff review of all tracked and untracked implementation files.
2. Automated gates: production/full dependency audits, Vite production build,
   Vitest, Rust tests, Rust formatting, Rust Clippy, Python compilation, and
   whitespace checks.
3. Live checks: shim health and Host-header rejection, model API/CORS behavior,
   Core health/policy/event endpoints, listener ownership, Firecrawl state, and
   retained-fleet hashes.
4. Focused source review of lifecycle rollback, memory/path boundaries,
   authority adapters, service authentication, and sidecar session handling.
5. Regression fixes followed by repeat execution of the focused and full tests.
6. Final focused pass over replay state, policy call coverage, lint/typecheck
   scope, sidecar path handling, and dormant legacy migration behavior.

## Defects found and corrected

| Severity | Area                    | Defect                                                                                                                                              | Correction                                                                                                     | Evidence                                                                                        |
| -------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| High     | Dependency remediation  | A global `brace-expansion@1.x` override broke ESLint's modern `minimatch` import (`expand` missing), making lint crash before analysis.             | Scoped the override to `minimatch@3>brace-expansion`; modern consumers retain their compatible release.        | `pnpm lint` starts successfully after reinstall; both audits remain clean.                      |
| High     | Model lifecycle         | Rollback selected the previous service by parameter count. Ornith and Agents-A1 share that count, so a missing alias could restart the wrong model. | Rollback now requires an exact live alias; ambiguous identity fails closed instead of selecting a wrong owner. | `local_runtime.py` compiles; existing lifecycle tests cover same-model and transition behavior. |
| High     | Memory API              | Recursive reads followed symlinks. A symlink below the memory root could disclose a file outside the root despite lexical path checks.              | Traversal now uses `lstat` and skips symbolic links.                                                           | Added symlink regression test; `swarm-memory.test.ts` passes (5/5).                             |
| Medium   | Lifecycle API           | Invalid `workerId` query values silently fell back to returning every worker's status.                                                              | Invalid explicit IDs now return HTTP 400.                                                                      | Route validation is explicit in `swarm-lifecycle.ts`.                                           |
| Medium   | Test hygiene            | A temporary `gateway-capabilities` mock remained active across the Hermes config tests, causing a false provider-list failure.                      | Reset the module cache and restore the baseline mock after the capability-unavailable case.                    | `-hermes-config.test.ts` passes 6/6; full Vitest passes 862/862.                                |
| Medium   | Test collection         | Vitest collected Playwright E2E files and reported `test.describe()` misuse.                                                                        | Added `**/e2e/**` to Vitest exclusions; E2E remains Playwright-owned.                                          | Full Vitest run has 148/148 files passing.                                                      |
| Low      | Legacy kanban migration | Cards without IDs all normalized to the same `legacy-missing-id`, creating collisions if the dormant importer was reused.                           | Fallback IDs now include the stable source-array index (`legacy-missing-id-1`, etc.).                          | Source review; full Vitest regression suite remains green.                                      |

## Verification results

| Check                                                   | Result                                                                                                                                                                 |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm audit --prod`                                     | PASS — no known vulnerabilities                                                                                                                                        |
| `pnpm audit`                                            | PASS — no known vulnerabilities                                                                                                                                        |
| `pnpm build`                                            | PASS — client and SSR bundles built                                                                                                                                    |
| `pnpm test -- --run`                                    | PASS — 148 files, 862 tests                                                                                                                                            |
| `pnpm lint`                                             | FAIL — 1,655 pre-existing source errors plus generated-bundle/config noise; command now executes rather than crashing                                                  |
| `cargo fmt --all -- --check`                            | PASS                                                                                                                                                                   |
| `cargo test --workspace --locked`                       | PASS                                                                                                                                                                   |
| `cargo clippy --workspace --all-targets -- -D warnings` | PASS                                                                                                                                                                   |
| Python shim compilation                                 | PASS                                                                                                                                                                   |
| Retained-fleet verifier                                 | PASS — 6 artifacts, 2 binaries, 5 services                                                                                                                             |
| Shim Host-header check                                  | PASS — untrusted host 403; localhost 200                                                                                                                               |
| Model CORS preflight                                    | PASS — no untrusted ACAO/credentials                                                                                                                                   |
| Core health/policy/event probes                         | Core healthy; policy and event journals currently empty                                                                                                                |
| GPU/process follow-up                                   | No active `llama-server`, Ollama, vLLM, or similar inference process; `ornith-llama.service` is inactive. `nvidia-smi` is unavailable, so numeric VRAM cannot be read. |
| Current model state                                     | No `llama-server`, no listener on 8080; model intentionally stopped by operator                                                                                        |

## Remaining findings

These are not silently treated as fixed:

1. **TypeScript release gate remains red (High).** `pnpm exec tsc --noEmit`
   still reports the existing route/type and playground errors. The production
   Vite build can succeed while this gate is red; release automation should not
   claim a clean typecheck.
2. **ESLint baseline remains red (Medium).** The current ESLint 10 configuration
   reports roughly 1,655 source errors and also traverses the generated server
   bundle. `.eslintignore` is deprecated under ESLint 10; ignores should be
   migrated into `eslint.config.js`, then source errors should be burned down.
3. **Service-request nonce replay after Core restart (Medium).** Core stores
   used nonces only in process memory. A captured, valid signed mutation could be
   replayed during its 30-second timestamp window after a Core restart. The
   current socket is mode 0700 and signatures are otherwise bound to method,
   path, action, payload, timestamp, and nonce. Persisted or restart-epoch-bound
   replay protection is still recommended before hostile same-user threat models
   are accepted.
4. **Policy enforcement evidence (High).** Live Core health is 200, but the
   policy decision and event queries currently return empty arrays. The code has
   fail-closed adapters and Rust policy tests, yet production mediation of every
   model/MCP/filesystem/network operation is not demonstrated.
5. **Provenance, recurring recovery/telemetry, and Slot 4 acceptance** remain as
   explicitly classified open/deferred items in the Bootstrap status addendum.
6. **Legacy kanban reader (Residual caution).** `swarm-kanban-store.ts` is no
   longer an execution authority. Missing IDs now receive deterministic,
   per-record fallback IDs, but references in external legacy files are not
   rewritten; a future migration should still materialize canonical IDs before
   enabling writes.

7. **Launcher argument trust (Low).** The Electron SSR launcher requires
   absolute, canonical files and pins the SSR basename to `prod-server.cjs`,
   but it intentionally accepts any canonical Electron runtime path. The
   launcher is a local packaging boundary, not a sandbox; deployment must keep
   its invocation and packaged directory permissions trusted.

## Residual observations

- The retained model service is intentionally stopped at review time; starting
  it is an operator action and is not required for the code/build gates.
- `nvidia-smi` is not installed in the current shell, so numeric VRAM telemetry
  could not be collected. Process, listener, endpoint, and service-state checks
  prove that no model server is running now. The codex-shim Python process is a
  small HTTP adapter configured to call `127.0.0.1:8080`; it is not itself a
  loaded model.
- The Vite build emits chunk-size and dynamic-import warnings; they are
  performance/packaging warnings, not correctness failures observed in this
  review.

## Recommended next order

1. Migrate ESLint ignores and establish a scoped, reviewable typecheck/lint
   baseline.
2. **Completed after review:** persist Core replay nonce digests in a private SQLite ledger, with expiry pruning and a router-restart regression test.

## Post-review remediation — durable service-request replay protection

The review's restart-window replay finding is resolved. Core now records only the SHA-256 digest of a successfully authenticated nonce in `StateDirectory=valkhana` before policy evaluation or Hermes execution. The SQLite ledger uses an immediate transaction to prune expired rows and atomically reject a duplicate digest; its directory/database modes are proved as `0700`/`0600`. A fresh Core router reopened against the same ledger rejects the exact previously accepted valid signed request. This removes the Core-restart replay window without changing the separate documented same-user credential-access limitation.
3. Instrument real PEP calls so policy/event journals prove effective mediation.
4. Finish provenance, scheduled restore drills/telemetry, and Slot 4 evidence.

## Post-review update — Core event boundary

After this review, Core gained a bounded, read-only, metadata-only in-memory
event journal. The live endpoint returning an empty event array remains
expected until a policy decision occurs after Core starts; the journal is not a
substitute for the durable policy SQLite audit ledger. See
[`EVENT-TELEMETRY-PRIVACY.md`](EVENT-TELEMETRY-PRIVACY.md) for verified limits
and remaining telemetry work.
