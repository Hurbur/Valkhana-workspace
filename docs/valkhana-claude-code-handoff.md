# Valkhana Claude Code Handoff

Updated: 2026-07-30

## Objective

Complete and verify the remaining Valkhana build-plan items on the Azure VM:

1. Organization view — implemented and independently reviewed.
2. Profile-scoped handoff/status flow — implemented; security correction is in
   independent re-review at handoff time.
3. Richer sessions — not yet implemented.

Do not regress the already completed Atlas themes, Daily Briefing, or
dashboard-only startup behavior. Do not expose any Azure public ports; shared
snapshots must remain Tailscale-only.

## VM and repository

SSH from Windows PowerShell:

```powershell
ssh -i "$env:USERPROFILE\Downloads\Testpilothermes_key_0729.pem" hermes-v1-test@100.98.83.117
```

The real durable checkout is **not** `~/projects` at the moment. Use:

```bash
export PATH="$HOME/.local/bin:$PATH"
cd /mnt/data/projects/valkhana-workspace/.worktrees/feat-valkhana-remaining-items
git branch --show-current
```

Expected branch: `feat/valkhana-remaining-items`.

`~/projects` is an incomplete old-path migration and currently hosts a stale
port-3001 preview / shells. Do not repair or remove it until those processes
are deliberately stopped. The durable repositories are under `/mnt/data/projects`.

## Important branches / repos

- Valkhana feature worktree:
  `/mnt/data/projects/valkhana-workspace/.worktrees/feat-valkhana-remaining-items`
- Main Valkhana repository:
  `/mnt/data/projects/valkhana-workspace`
- AtlasOS reference only, never merge wholesale:
  `/mnt/data/projects/atlas-os-reference`
- Upstream Hermes Agent is installed at:
  `~/.hermes/hermes-agent`
  Keep it upstream-trackable. Do not fork or modify it for Workspace work.

## Commits on the active branch

- `c3adcd34` docs-remaining-items-plan
- `b32afa73` test-dashboard-adapter-isolation
- `0c6a7001` feat(swarm2): add organization radial view
- `d2e25d8a` fix(swarm2): harden radial topology
- `657f0241` fix(swarm2): share worker state semantics
- `a371aa17` test(swarm2): prove radial wire remeasurement
- `2bb568e3` feat(handoff): add profile-scoped status flow
- `f482d1b0` fix(handoff): harden writer authorization

## Item 3: organization view

Accepted implementation:

- Radial Swarm view mode with central live hub and compact worker nodes.
- Existing `Swarm2Wires` is reused; it changes anchor to the actual radial hub.
- Small layout uses a non-clipping grid; one-worker layout is visible.
- Worker state derivation is shared with `OperationalWorkerCard`.
- Component test proves rendered SVG wire geometry changes after a hub rect and
  ref-version change.

Evidence:

```bash
CLAUDE_API_URL=http://example.invalid npx --yes pnpm@10 test \
  src/screens/swarm2/swarm2-radial-view.test.ts \
  src/screens/swarm2/swarm2-radial-view.component.test.tsx \
  src/screens/swarm2/swarm2-screen.test.ts
```

Latest reported result: 19/19 tests passed; production build passed.

## Item 4: handoff/status flow

Implementation files include:

- `src/server/valkhana-dashboard-adapter.ts`
- `src/server/valkhana-profile-store.ts`
- `src/server/valkhana-handoff-status.ts`
- `src/server/valkhana-handoff-auth.ts`
- `src/server/valkhana-handoff-service.ts`
- `src/routes/api/dashboard/handoff-status.ts`
- `src/routes/api/internal/handoff/brain.ts`
- `src/screens/dashboard/components/handoff-status-card.tsx`

Security correction in `f482d1b0`:

- Browser mutation fails closed with HTTP 503 unless Workspace password auth is
  explicitly configured and the caller has a valid session.
- Browser patch allows only `state`, `summary`, `nextAction`, and `blocker`.
- Lifecycle is server-enforced: Brain writes `idle -> brain-working ->
  ready-for-terminal`; terminal starts only from `ready-for-terminal` and then
  transitions to controlled completion/blocking states.
- Internal Brain writer uses a separate required
  `HERMES_HANDOFF_BRAIN_TOKEN`; it assigns actor `brain` server-side and does
  not use or expose any Codex/LLM credential.
- Profile metadata reads reject symlinks escaping the trusted profile directory.

Operator configuration still required before the mutation flows intentionally
become usable:

```dotenv
# Workspace browser session auth, used for interactive terminal/card mutation
HERMES_PASSWORD=<strong-unique-password>

# Separate long random value, only for trusted Brain/background writer
HERMES_HANDOFF_BRAIN_TOKEN=<long-random-token>
```

These secrets must go in the Workspace process environment / ignored `.env`.
Never print, commit, or put them into Hermes dashboard credentials. With either
missing, the system should reject unsafe mutation rather than silently open it.

Latest reported verification:

```bash
CLAUDE_API_URL=http://example.invalid npx --yes pnpm@10 test \
  src/server/valkhana-dashboard-adapter.test.ts \
  src/server/valkhana-handoff-status.test.ts \
  src/server/valkhana-profile-store.test.ts \
  src/server/valkhana-handoff-auth.test.ts \
  src/routes/api/dashboard/-handoff-status.test.ts \
  src/routes/api/internal/handoff/-brain.test.ts \
  src/screens/dashboard/components/handoff-status-card.test.tsx \
  src/screens/dashboard/lib/use-dashboard-layout.test.ts
npx --yes pnpm@10 build
```

Reported result: 26/26 focused tests, build exit 0 (pre-existing Vite warnings
only). At handoff time, a high-effort independent re-review of the correction
diff `/tmp/valkhana-handoff-rereview.diff` is still running / must be checked
before Item 4 is accepted.

## Item 5: richer sessions — remaining work

Implement according to:

`docs/superpowers/plans/2026-07-30-valkhana-remaining-items.md`

Requirements:

- Profile-owned `session-organizer.json`, keyed by stable session ID, with
  pin/archive/project/tags/update time; never duplicate full transcripts.
- Extend the existing cookie-forwarding adapter with read-only normalized
  session list/detail reads; preserve GET-only allowlist for dashboard reads.
- Authenticated Workspace session organizer routes for metadata, filter,
  Markdown/JSON export, snapshot creation/read.
- Share snapshots must be sanitized/read-only, capability-ID based, expiry
  checked, and reachable only on the Tailscale network. Do not make an
  anonymous/public internet route or open Azure ports.
- Add a Dashboard organizer panel/card. Do not try to make legacy Workspace
  Chat work: Hermes 0.19 has no legacy `/v1/chat/completions` endpoint.
- Use test-first development and independent task review.

## Commands and known runtime facts

- Noninteractive SSH PATH often lacks Node tools. Start remote commands with:
  `export PATH="$HOME/.local/bin:$PATH"`
- Dashboard is Hermes on `0.0.0.0:7860`, protected by Basic/cookie auth and
  reachable through Tailscale. Keep it off public Azure exposure.
- Workspace dev preview should not auto-start another Hermes gateway:

```bash
HERMES_WORKSPACE_AUTO_START_AGENT=false \
CLAUDE_API_URL=http://127.0.0.1:8642 \
npx --yes pnpm@10 dev --host 0.0.0.0
```

Hermes gateway `:8642` is not present in this Hermes version. Dashboard-only
startup was deliberately fixed earlier; Workspace Chat remains an honest
capability gap, not a configuration problem.

## Existing verified work not to regress

- Atlas theme families / light variants and picker registration.
- Daily Briefing cookie-forwarding dashboard adapter.
- Dashboard-only startup when Hermes `:7860` dashboard is available but old
  chat gateway `:8642` is not.

Focused regression baseline:

```bash
CLAUDE_API_URL=http://example.invalid npx --yes pnpm@10 test \
  src/lib/theme.test.ts \
  src/routes/api/-auth-check.test.ts \
  src/server/valkhana-dashboard-adapter.test.ts
```

## Git / delivery

GitHub auth on the VM was set up with `gh auth login` / `gh auth setup-git`.
Push only after accepted task reviews and verification:

```bash
git push -u origin feat/valkhana-remaining-items
```

Do not push credentials, generated `.env`, snapshots containing message data,
or changes to Azure / Tailscale exposure.
