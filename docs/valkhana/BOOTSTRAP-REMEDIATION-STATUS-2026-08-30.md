# ValKhana Bootstrap remediation status — 2026-08-30

This is a live-state addendum to the 2026-08-29 audits. Historical reports are
preserved unchanged. No retired/deleted model was restored, and the operator's
passwordless sudo and GitHub PAT decisions were not modified.

## Executive result

The retained local model lane is restart-safer and the two concrete network
exposure paths have been contained. Firecrawl is loopback-only with a passing
container healthcheck. All retained llama service profiles now constrain CORS
to localhost and disable CORS credentials. The shim validates target artifacts,
requires exact runtime identity, rolls back best-effort after a failed start,
and applies a deterministic failure cooldown.

This is not a production/autonomous-operation sign-off. Upstream artifact
provenance, effective Core policy mediation, live Hermes authority, recurring
recovery operations and Slot 4 acceptance remain open
or deferred. The dependency audit is resolved: both production and full audits
now report no known vulnerabilities.

Disposition count (19 tracked findings): **7 resolved**, **2 superseded**, **2
accepted operator decisions**, **1 not applicable**, **2 deferred**, **4 still
open**, and **1 future-architecture item**. There are no unresolved P0 network
exposures in the retained local lane; the remaining open items still block an
autonomous-operation sign-off.

## Finding reconciliation

| Finding | Current evidence | Disposition | Action / residual risk |
|---|---|---|---|
| Firecrawl all-interface unauthenticated publication | Host publish is `127.0.0.1:3002`; LAN/Wi-Fi/Tailscale probes fail; API container is healthy | RESOLVED | Keep remote access disabled unless an authenticated boundary is deliberately added |
| Firecrawl oneshot/missing health evidence | API Compose healthcheck passes; `docker compose ps` reports healthy | RESOLVED | systemd oneshot remains an intentional launcher; inspect Compose health for runtime status |
| llama.cpp wildcard browser CORS | Active Ornith preflight for an untrusted origin has no ACAO; credentials false; all retained units carry the same environment | RESOLVED | Keep model servers loopback-only; no performance flags changed |
| Stale Slot 3 identity / Ornith message ordering | Live alias, 102400 context, 34660610688 params; slot-prefixed hoist code present | RESOLVED | Preserve current Slot 3 profile |
| Qwen3.6 missing artifact | Operator confirms intentional deletion; no active Qwen3.6 service/profile | SUPERSEDED | Do not recover or validate it |
| Retired KAT-Coder / Ornith 1.0 candidates | Operator-selected Ornith 1.5 is active | SUPERSEDED | Historical evidence only |
| Shim omitted active owner / repeated failed switching | Current profiles enumerate retained services; switcher has artifact/binary preflight, exact alias check, rollback, cooldown | RESOLVED | Run a controlled cross-model canary before changing the active model |
| Validated model tree writable by worker identity | Retained artifacts are now mode `0444`; immediate production directories are `0555` | RESOLVED (local boundary) | Operator promotion must deliberately restore write mode; upstream authenticity remains separate |
| Incomplete upstream provenance | Local hashes/sizes recorded in `RETAINED-FLEET-MANIFEST-2026-08-30.md`; upstream source/revision/license not yet proven | STILL OPEN | Complete provenance and signed/immutable validation |
| Core healthy but not evidenced as enforcement path | Core health 200; policy DB contains 0 decisions and 0 approvals | STILL OPEN | Integrate and verify applicable PDP/PEP adapters |
| Hermes task authority / Telegram health | No `hermes` executable, Hermes user service, or live Hermes state DB is present on this host | NOT APPLICABLE TO THIS HOST | Do not install it for this remediation; re-open only if Hermes is deliberately deployed here |
| Production dependency advisories | Original audit: 1 critical, 13 high, 32 moderate, 10 low; current `pnpm audit --prod` and full `pnpm audit` are clean | RESOLVED | Targeted overrides and compatible direct upgrades applied; retain lockfile and re-audit before release |
| TypeScript baseline | Patched compatible TanStack Start 1.168.49/Router 1.170.32 line, explicit application/test contracts, and separate Cloudflare worker project all typecheck cleanly; full Vitest passes | RESOLVED | Retain both typecheck commands in the release gate |
| Slot 4 acceptance | Agents-A1 is retained but not acceptance-complete | DEFERRED | Complete required acceptance evidence before autonomous selection |
| Backup/restore and fleet observability | A non-destructive isolated backup/restore drill is documented and recorded; repeatable schedule/telemetry is not evidenced | RESOLVED (minimum drill) / DEFERRED (ongoing operations) | Establish scheduled restore drills, retention, and identity telemetry |
| Unrestricted passwordless sudo | Explicit operator decision | ACCEPTED OPERATOR DECISION | No action |
| GitHub PAT arrangement | Explicit operator decision | ACCEPTED OPERATOR DECISION | No action |
| Permanent Rust runtime manager, broad PEP, deterministic router/finalizer | Not required to repair the current contained lane; shim now reports `auto_router: false` | FUTURE ARCHITECTURE WORK | Track separately; automatic routing is disabled until prerequisites exist |

## Changes made

- `/home/jbhurbie/.local/src/firecrawl/docker-compose.yaml`: host API publication changed from all interfaces to `127.0.0.1`; API healthcheck added. Rollback: restore the prior port mapping and remove the healthcheck, then recreate the API container.
- Retained llama user units (`ornith-llama.service`, `ornith-9b.service`, `gemma-4-26b.service`, `agents-a1.service`, `qwen3.8.service`): localhost-only CORS and credentials-disabled settings added. Rollback: remove the two `LLAMA_ARG_CORS_*` environment entries (and the equivalent active Ornith flags), reload, and restart the selected unit.
- `codex_shim/local_runtime.py`: retained artifact/binary preflight, exact alias readiness, best-effort rollback, cooldown, and local profile artifact metadata added. Rollback: revert this file to the reviewed pre-remediation revision.
- `codex-shim.service`: `CODEX_SHIM_DISABLE_ROUTER=1` added so the ungoverned optional auto-router cannot select models. Rollback: remove the environment entry, reload, and restart the shim after its prerequisites are reviewed.
- Retained llama units and `codex-shim.service`: added `NoNewPrivileges=yes`, `PrivateTmp=yes`, and `UMask=0077`; active units were restarted and remained healthy. Broader sandbox controls remain deferred pending compatibility testing.
- Retained llama units and `codex-shim.service`: added `ProtectSystem=strict` and `ProtectHome=read-only`; active units were restarted and verified healthy with unchanged model identity. Rollback: remove those two directives, reload, and restart.
- This status addendum and `RETAINED-FLEET-MANIFEST-2026-08-30.md` were added; historical audit files were not rewritten.
- Dependency remediation: `package.json`, `pnpm-workspace.yaml`, and `pnpm-lock.yaml` now pin patched transitive versions (including `seroval`, `h3`, `dompurify`, `undici`, `js-yaml`, `postcss`, `nanoid`, `yaml`, `esbuild`, and related tooling) and upgrade compatible TanStack Start, Electron, Electron Builder, and concurrently releases. Rollback: revert these three dependency files together, then reinstall from the prior lockfile.

## Validation matrix

| Test | Expected | Actual |
|---|---|---|
| Firecrawl host binding | loopback only | PASS: `127.0.0.1:3002`; remote interface probes `000` |
| Firecrawl API health | healthy | PASS: Compose reports `Up (healthy)` |
| Ornith health/identity | active, exact alias/context/params | PASS |
| Untrusted model CORS preflight | no ACAO, no credentials | PASS |
| Shim missing-target preflight | refuse without stopping current owner | PASS |
| Shim repeated deterministic failure | cooldown response | PASS |
| Shim same-model selection | no systemd calls | PASS |
| Rust workspace | tests pass | PASS (`cargo test --workspace --locked`) |
| Retained fleet verifier | hashes, read-only artifacts, service aliases/paths | PASS (`scripts/verify-retained-fleet.py`) |
| Shim auto-router gate | disabled until permanent prerequisites | PASS: health reports `auto_router: false`; `codex-auto` absent |
| Basic service hardening | no privilege gain, private temp, restrictive umask, read-only system/home | PASS: active Ornith and shim show all five controls; exposure scores improved from 9.8 to 8.9 (broader hardening still required) |
| Root TypeScript typecheck | clean | PASS: `pnpm exec tsc --noEmit` |
| Cloudflare worker TypeScript typecheck | clean | PASS: `pnpm exec tsc -p playground-ws-worker/tsconfig.json --noEmit` |
| Vitest/Playwright collection | Vitest excludes `e2e/**`; Playwright owns E2E suites | PASS: collection is separated; one pre-existing Hermes config test remains flaky in the full parallel run (passes in isolation) |
| Dependency audit (production) | zero advisories | PASS: `pnpm audit --prod` |
| Dependency audit (full tree) | zero advisories | PASS: `pnpm audit` |
| Production build | successful client and SSR bundles | PASS: `pnpm build` |

## Current fleet

See `RETAINED-FLEET-MANIFEST-2026-08-30.md` for paths, sizes, hashes, aliases,
contexts, services, and status. Local hashes establish an integrity baseline;
they are not upstream authenticity proof.

## Remaining work

Only the STILL OPEN and DEFERRED items above are current remediation work.
Accepted operator decisions, absent tools, and intentionally retired/deleted
models are not remediation tasks.
