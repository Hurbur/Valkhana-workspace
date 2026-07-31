# Valkhana Remaining Items Implementation Plan

> Execute on branch `feat/valkhana-remaining-items`.

## Baseline and shared plumbing

1. Add `docs/superpowers/specs/2026-07-30-valkhana-remaining-items-design.md`
   from the approved design and this plan at
   `docs/superpowers/plans/2026-07-30-valkhana-remaining-items.md`.
2. Run the existing focused theme/startup/briefing test suite and record any
   pre-existing failures before edits.
3. Correct the Dashboard widget catalog so `daily_briefing` is a catalog item,
   not an invalid member of `DEFAULT_HIDDEN`; add the upcoming `handoff_status`
   card as a visible rail item.

## Item 3 — organization view

1. Add `radial` to `ViewMode` and the orchestrator view selector in
   `src/screens/swarm2/swarm2-orchestrator-card.tsx`.
2. Create `src/screens/swarm2/swarm2-radial-view.tsx`:
   - receive existing worker/runtime/selection callbacks;
   - expose one actual DOM ref per worker node;
   - place nodes from an angle/radius calculation responsive to available
     width, rather than fixed absolute positions;
   - use accessible buttons and preserve card-view actions.
3. In `swarm2-screen.tsx`, render the radial view only for `viewMode ===
   'radial'`, pass its refs into the existing `Swarm2Wires`, and leave other
   view modes untouched.
4. Add focused unit tests for radial registration and deterministic position
   helpers; browser-smoke the new control with live/no-worker states.

## Item 4 — handoff/status flow

1. Create `src/server/valkhana-profile-store.ts` to resolve active profile
   identity/path via the cookie-forwarding dashboard adapter, validate it is a
   dashboard-provided profile path, and atomically read/write profile-owned
   JSON metadata.
2. Create `src/server/valkhana-handoff-status.ts` with the versioned status
   schema, normalization, stale calculation, and explicit transition
   validation. Do not accept arbitrary client paths or actors.
3. Add `GET`/`PATCH` route
   `src/routes/api/dashboard/handoff-status.ts`, guarded by Workspace
   authentication and JSON-content checks. A PATCH receives only a vetted
   state/summary/next-action/blocker payload.
4. Create `src/screens/dashboard/components/handoff-status-card.tsx`; poll
   every minute, show status/age/stale signal, and expose the permitted
   terminal state transition. Register it through `use-dashboard-layout.ts`
   and `dashboard-screen.tsx`.
5. Add unit tests for profile isolation, path validation, malformed JSON,
   stale calculation, and rejected transitions. Verify the active profile file
   on the VM without exposing credentials.

## Item 5 — richer sessions

1. Extend `valkhana-profile-store.ts` with profile-owned
   `session-organizer.json` metadata and schema normalization.
2. Extend `valkhana-dashboard-adapter.ts` with normalized list/detail session
   reads only; keep its Dashboard route allowlist GET-only.
3. Add authenticated routes under `/api/dashboard/sessions/*` for metadata
   list/update, export, and snapshot creation/read. Snapshot reads require a
   capability ID and verify the request is from Tailscale (`100.64.0.0/10` or
   `.ts.net` host); exports strip messages, credentials, and arbitrary raw
   metadata.
4. Add a `Session Organizer` dashboard card/panel supporting pin/archive,
   project and tag assignment, filters, Markdown/JSON export, and a
   Tailscale-only snapshot link. The legacy Chat sidebar is not made dependent
   on this work because the installed Hermes lacks its required chat gateway.
5. Add unit tests for metadata isolation, filtering, export format,
   sanitization, expiry, and tailnet request validation. Browser test the
   organizer with live Dashboard session data and confirm snapshots reject a
   non-tailnet request.

## Final verification and delivery

1. Run focused Vitest tests for all new modules plus the prior theme/startup/
   briefing tests.
2. Run `pnpm build` (via the project’s `npx --yes pnpm@10` invocation).
3. Use the VM browser over Tailscale to verify visible flows.
4. Commit cohesive checkpoints, push the feature branch, and report the known
   Hermes chat capability gap separately from completed work.
