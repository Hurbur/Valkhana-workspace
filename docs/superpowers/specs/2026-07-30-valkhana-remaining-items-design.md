# Valkhana Remaining Items Design

Date: 2026-07-30

## Scope

Complete build-plan items 3–5 without modifying Hermes Agent upstream or
opening any Azure public ports:

1. An organization view for live Swarm workers.
2. A profile-scoped handoff/status flow between a background Brain job and a
   terminal coding agent.
3. Richer session organization, export, and share snapshots.

The existing Atlas theme work and Daily Briefing remain intact. Workspace Chat
is deliberately out of scope because Hermes 0.19 does not expose the legacy
chat-completions API that Workspace expects.

## Security boundary

All new Workspace routes remain protected by the existing Workspace browser
authentication unless explicitly described as a shared snapshot. Shared
snapshots are reachable only from the VM's Tailscale address; they use
unguessable capability IDs, carry no source credentials, and contain a
sanitized, read-only Markdown/JSON projection. No Azure NSG rule, public
tunnel, reverse proxy, or dashboard password/cookie is exposed.

Dashboard reads continue to use the existing server-side cookie adapter.
Credentials remain in the Workspace `.env` and never reach client JavaScript.

## Organization view

Add a `radial` Swarm2 view mode. It presents one compact orchestrator hub in
the centre with a compact node for each worker positioned around it. Node
status, selected state, room membership, task summary, and role remain live
because they use the existing `CrewMember`/runtime data already used by the
card view.

`Swarm2Wires` remains the sole connection renderer. It will receive each
radial node's actual element reference, so ResizeObserver and viewport resize
updates continue to calculate connector geometry rather than depending on
hard-coded coordinates. The existing card, kanban, runtime, and reports views
are preserved unchanged.

## Handoff/status contract

Each Hermes profile owns a single JSON file named `handoff-status.json` in
that profile's directory. The schema is versioned and includes profile ID,
updated time, actor, state (`idle`, `brain-working`, `ready-for-terminal`,
`terminal-working`, `blocked`, or `complete`), concise summary, next action,
blocker, and optional source/job reference.

Workspace resolves the active profile only through the existing authenticated
dashboard adapter and accepts only a profile path returned by the dashboard.
It never accepts a client-provided filesystem path. Reads and atomic writes
are implemented server-side; writes validate the schema and use a temporary
file plus rename. A Dashboard card polls the normalized status, displays a
stale indicator when it has not been updated for fifteen minutes, and offers
explicit state transitions suitable for the background Brain job and terminal
agent. This is a coordination contract, not an attempt to relay Codex or
Claude credentials.

## Richer sessions

Session metadata belongs to the active Hermes profile in
`session-organizer.json`, keyed by stable session ID. It stores pin status,
archive status, project, tags, and the editor/update timestamp; it never
duplicates full chat content. The server joins this metadata with the existing
read-only Dashboard session list.

The Sessions UI gets a profile-aware organizer panel with filters for project,
tag, archived state, and pin state. It offers Markdown and JSON exports
generated server-side from the normalized session projection. A snapshot is a
separate sanitized export: the user explicitly creates it, it strips raw
messages/secrets, and the returned URL is tailnet-only with a random ID and
expiry. It does not reuse the public dashboard or anonymous internet access.

## Verification

Unit tests cover schema validation, profile path rejection, atomic metadata
normalization, snapshot sanitization/expiry, radial view registration, and
adapter joins. Focused Vitest tests plus production build run before each
commit. Browser verification uses the VM's local agent browser over Tailscale
to confirm the new Swarm control, handoff card, session filters, and an
authenticated snapshot flow.
