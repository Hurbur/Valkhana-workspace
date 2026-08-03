# Dashboard TypeScript Error Triage — Session Record (2026-08-03)

This exists so a future Claude Code session (native on the VM or SSH-driven)
can pick up bug-hunting in `valkhana-workspace` without re-deriving what was
already checked. `tsc --noEmit` currently reports 86 errors across the app
(down from 88 at session start — 2 net after 5 real bugs fixed, since some
fixes collapsed multiple reported lines into one and some pre-existing
unrelated errors shifted line numbers in the process).

Fixed this session, commits `2e30eb82`, `325e0e4d`, `7a5e3452` on `main`:
- Web terminal (`terminal-panel.tsx`): copy-on-select / Ctrl+C copy was
  fully broken (`document.execCommand('copy')` had no real DOM selection
  to act on against xterm.js's own selection overlay).
- Terminal scrollback replay (`terminal-sessions.ts`): a reconnect-replay
  feature (someone else's WIP, picked up and finished) was broadcasting
  scrollback to *every* attached listener via `emitter.emit()`, causing
  duplicate output in already-open tabs whenever a new tab joined the same
  session. Fixed to call the newly-attaching listener directly.
- 5 bugs found via targeted `tsc` error triage (see `7a5e3452` commit body
  for full detail): `CpuIcon` missing import (crash), `THEME_PREVIEWS`
  missing 8 of 20 theme entries (crash on those themes), 3x `toast()`
  calls passed an object instead of a string (crashed the whole app via
  "Objects are not valid as a React child"), a dead `card.prUrl` read
  (PR-link button silently never rendered), a wrong-shape object passed to
  the "Steer" reviewer button (garbled `undefined` prompts), and 2 invalid
  status-enum values silently mislabeling ready agents in two UI panels.

## How this session triaged: methodology, so it's reproducible

For each `tsc` error, don't trust the error message alone — read the
surrounding code and ask: is this value *actually* reachable at runtime
with the "wrong" type, and if so, does the consuming code crash or
silently misbehave? Many TS errors here are **false positives in
practice** — the type system can't see a guard/invariant that the code
already enforces (control flow across `?.`, values gated behind
unreachable branches, etc). Don't "fix" those by relaxing types or adding
redundant guards; they're not bugs. Only ones with a real, reachable,
observable defect are worth fixing.

## Confirmed FALSE POSITIVES — do not re-investigate these, reasoning already established

| File:Line | Error | Why it's not a real bug |
|---|---|---|
| `swarm2-screen.tsx:639-1433` (6 errors) | `lastRealSummary`/`lastRealResult` don't exist on `RuntimeEntry` | Dead fields from an incomplete rename, but every read is inside a `??` fallback chain that lands on the real `lastSummary`/`lastResult` fields. No behavior change. Could be cleaned up (delete the dead reads) but not urgent. |
| `server/valkhana-dashboard-adapter.ts:384-385` | `matchingProfile` possibly undefined, used unguarded | TS can't narrow across the `matchingProfile?.path` indirection a few lines above; that check already throws before this code runs if `matchingProfile` were undefined. Provably safe. |
| `routes/reserve/confirm.tsx:12` | `token`/`strict` don't exist on search-params type | Route has no `validateSearch` schema so TS infers `{}`, but TanStack Router still returns real parsed query params at runtime. Type-safety gap, not a functional bug. |
| `server/swarm-roster.ts:98` | Fallback roster object missing `plugins`/`modes`/`tools`/`pluginToolsets`/etc | Confirmed via grep: no consumer anywhere in the codebase reads those fields off a roster-sourced worker object today. Dead/unconsumed — but a landmine if a future feature starts reading them. |
| `server/swarm-lifecycle.ts:381,393` (8 errors) | `tmuxBin(): string \| null` passed to `execFile` | `null` only returned on Windows; the only call sites are gated by `useNativeProcess()` which is `true` on Windows, short-circuiting before this code runs. Structurally unreachable given the current call graph. |
| `routes/api/swarm-lifecycle.ts:48,52` | `'ok'` specified twice in object literal | Both values are the literal same expression (`result.ok`) — "overwrite" replaces a value with itself. No behavior change. |
| `routes/api/swarm-runtime.ts:198-199` (4 errors) | `roster` possibly undefined, used unguarded | `readSwarmRoster` always injects a fallback entry for every requested id, so `.get(workerId)` for the id just passed in should always resolve today. Low risk, but worth a defensive guard if that fallback-injection guarantee ever changes. |
| `screens/gateway/hooks/use-conductor-gateway.ts:1666` | `string \| null` passed to `Set.delete()` | `Set.prototype.delete(null)` is a safe no-op, not a throw. |
| `routes/api/models.ts:76,78` | `string \| undefined` passed to `Set.has()`/`.add()` | `normalizeModel()` guarantees a non-empty string at runtime despite the wider `id?: string` type; even if not, `Set` methods don't throw on undefined. |
| `screens/chat/hooks/use-realtime-chat-history.ts:426` | `Cannot find module '@/types/chat'` | Used only in a type-cast position (`as unknown as import(...)`), fully erased at build time. `src/types/chat.ts` genuinely doesn't exist — stale reference, but harmless. Worth deleting for `tsc` hygiene. |
| `screens/chat/components/chat-sidebar.tsx:258,276` | Search params type mismatch on `<Link search={...}>` | TanStack Router serializes whatever plain object is passed; doesn't enforce the strict schema at runtime, only at compile time. |
| `components/workspace-shell.tsx:201` (3 errors) | `search.embed`/`search.mode` don't exist on inferred type | Only 2 routes in the whole tree declare `validateSearch` (`tasks.tsx`, `settings/index.tsx`) — this route has none, so nothing strips `embed`/`mode` from `location.search` at runtime. Type is just built from unrelated routes' schemas. **Not independently verified by loading the app with `?embed=1`** — if this feature has been reported flaky, check that first before trusting this verdict fully. |
| `components/terminal/terminal-workspace.tsx:466` | `null` cast to `Timeout` | Unnecessary cast; `clearTimeout(null)` is a safe no-op regardless. |
| `components/prompt-kit/text-shimmer.tsx:24-30` (3 errors) | JSX children type collapses to `never` | `TextShimmer` component is not imported/used anywhere else in the codebase (`grep -rn "TextShimmer" src` only hits its own definition). Dead code — moot either way. |
| `stores/chat-store.ts:916-917` (2 errors) | `Array.prototype.findLastIndex` not recognized | Purely a `tsconfig.json` `lib` target gap (set to ES2022, needs ES2023). Node 22.23.2 (what's actually running) fully supports it at runtime — confirmed via `typeof [].findLastIndex === 'function'`. Cosmetic only. |
| `screens/swarm2/swarm2-orchestrator-card.tsx:350` | `processType` prop required but not passed | The receiving component's destructuring never references `processType` in its body. Omitting it has zero runtime effect. |
| `screens/dashboard/components/attention-card.tsx:15`, `attention-marquee.tsx:7` | Icon/color maps missing `kanban` key | **Flagged but NOT independently verified this session** (found via the original bulk `tsc` scan, not covered by any of the 4 parallel investigation agents). If an "attention" item of kind `kanban` is ever surfaced, indexing these maps would return `undefined` — check whether `kanban` is actually a reachable attention-card kind before trusting this as harmless. |

## NOT YET INVESTIGATED — real remaining work

- **`playground-ws-worker/src/worker.ts`** (10 errors) and the 3D playground screens (`playground-world-3d.tsx`, `use-playground-rpg.ts`, `playground-environment.tsx`, `playground-glb-body.tsx`, `playground-dialog.tsx`, `player-character.tsx`, `npc-character.tsx` — 17 errors total): entirely skipped this session as lower-priority/experimental. Includes a real-looking one: `playground-world-3d.tsx(2916,25)`: `"training"` not assignable to the expected world-id union — could be a genuinely unreachable/broken world.
- **`routes/settings/index.tsx:416`**: `SettingsNavId` vs `"routing"` comparison "has no overlap" — not investigated, could be dead code checking for a nav id that no longer exists, or a real bug where a routing-related settings section is unreachable.
- **`routes/settings/index.tsx:2302`**: `customProviderCatalogEntry` possibly undefined, unguarded — not investigated, could be a real crash risk if a custom provider is misconfigured.
- **9 `.test.ts`/`.test.tsx` files** (each 1-2 errors): deliberately skipped as not affecting the running dashboard, but they do mean those tests may not be running/passing in CI if `tsc` gates the test run — worth checking separately.
- **Full app was not manually exercised in a browser this session** — all triage was static (code reading + `tsc`), not verified by loading the actual pages. The `embed`/`mode` and `kanban` items above specifically call this out, but it applies as a general caveat to every "false positive" verdict in this doc: they're reasoned from code, not observed live.

## Process notes for whoever continues this

- Build/deploy: `export PATH=/home/hermes-v1-test/.hermes/node/bin:$PATH`, then `./node_modules/.bin/tsc --noEmit` and `./node_modules/.bin/vite build` directly (not via `pnpm`, which can abort with `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` over non-interactive SSH).
- Deploy: `systemctl --user restart valkhana-workspace.service` — **never** manually `kill`+`nohup`, it races against systemd's own auto-restart and causes a real (if transient) crash loop.
- Verify: `curl -sk https://127.0.0.1:3000/` — HTTPS only (Tailscale cert via `.env` `TLS_CERT_PATH`/`TLS_KEY_PATH`), plain `http://` gives a misleading "Empty reply from server".
- `HANDOFF-AUTOMATION-DESIGN.md` in the repo root is unrelated, separate in-progress work (Claude/Codex handoff automation project) — leave it alone unless that's specifically what you're working on.
