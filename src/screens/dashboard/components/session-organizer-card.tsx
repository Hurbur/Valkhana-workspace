import { useEffect, useMemo, useState } from 'react'
import { HugeiconsIcon } from '@hugeicons/react'
import { Folder01Icon } from '@hugeicons/core-free-icons'

type OrganizedSession = {
  id: string
  title: string | null
  source: string | null
  lastActive: number
  messageCount: number
  metadata: {
    pinned: boolean
    archived: boolean
    project: string | null
    tags: Array<string>
    updatedAt: string | null
  }
}

type SessionsResponse = {
  profile?: { id: string; name: string }
  sessions?: Array<OrganizedSession>
  total?: number
  error?: string
}

type Filters = {
  project: string
  tag: string
  showArchived: boolean
}

const EMPTY_FILTERS: Filters = { project: '', tag: '', showArchived: false }

function buildQuery(filters: Filters): string {
  const params = new URLSearchParams()
  if (filters.project.trim()) params.set('project', filters.project.trim())
  if (filters.tag.trim()) params.set('tag', filters.tag.trim())
  if (!filters.showArchived) params.set('archived', 'false')
  const query = params.toString()
  return query ? `?${query}` : ''
}

/**
 * Builds the snapshot-creation request body from the same filter state the
 * list/export views use, so a share link reflects what the operator is
 * actually looking at rather than always snapshotting every session
 * regardless of the current view.
 */
function buildSnapshotFilters(filters: Filters): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  if (filters.project.trim()) body.project = filters.project.trim()
  if (filters.tag.trim()) body.tag = filters.tag.trim()
  if (!filters.showArchived) body.archived = false
  return body
}

/**
 * Session Organizer: browses the active profile's live Hermes sessions
 * joined with local pin/archive/project/tag metadata
 * (`/api/dashboard/sessions`), exports the current view
 * (`/api/dashboard/sessions/export`), and can mint a Tailscale-only,
 * time-boxed share link (`/api/dashboard/sessions/snapshot`) that does not
 * require a Workspace login to open. See
 * `src/server/valkhana-session-service.ts` and
 * `src/server/valkhana-session-snapshot.ts` for the server-side contract.
 *
 * Scope note: this reads from the Hermes Agent dashboard's own session
 * store (CLI/cron/Telegram/TUI/browser activity, everything Hermes has
 * logged) via the cookie-forwarding adapter - a DIFFERENT backend and
 * likely a different session-id space than the primary chat sidebar's
 * session list (`src/screens/chat/chat-queries.ts`'s fetchSessions(),
 * which reads the Workspace's own CLAUDE_API gateway sessions). Pinning a
 * session here does not affect the sidebar's separate
 * usePinnedSessions() store, and vice versa - the two are not the same
 * data, so the card labels itself explicitly rather than implying a
 * single unified session list.
 */
export function SessionOrganizerCard() {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS)
  const [data, setData] = useState<SessionsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [snapshotStatus, setSnapshotStatus] = useState<
    | { kind: 'idle' }
    | { kind: 'creating' }
    | { kind: 'ready'; url: string; expiresAt: string }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' })

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch(`/api/dashboard/sessions${buildQuery(filters)}`)
      .then((res) => res.json())
      .then((body: SessionsResponse) => {
        if (!cancelled) setData(body)
      })
      .catch(() => {
        if (!cancelled) setData({ error: 'failed to load sessions' })
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [filters])

  const sessions = useMemo(() => data?.sessions ?? [], [data])

  async function mutateSession(
    sessionId: string,
    patch: Partial<{ pinned: boolean; archived: boolean }>,
  ) {
    await fetch('/api/dashboard/sessions', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, ...patch }),
    })
    setFilters((prev) => ({ ...prev }))
  }

  function exportCurrentView(format: 'json' | 'markdown') {
    const query = buildQuery(filters)
    const extra = query ? `&${query.slice(1)}` : ''
    window.open(
      `/api/dashboard/sessions/export?format=${format}${extra}`,
      '_blank',
    )
  }

  async function createShareLink() {
    setSnapshotStatus({ kind: 'creating' })
    try {
      const res = await fetch('/api/dashboard/sessions/snapshot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          format: 'markdown',
          ...buildSnapshotFilters(filters),
        }),
      })
      const body = (await res.json()) as {
        id?: string
        expiresAt?: string
        error?: string
      }
      if (!res.ok || !body.id || !body.expiresAt) {
        setSnapshotStatus({
          kind: 'error',
          message: body.error ?? 'snapshot creation failed',
        })
        return
      }
      const url = `${window.location.origin}/api/dashboard/sessions/snapshot/${body.id}`
      setSnapshotStatus({ kind: 'ready', url, expiresAt: body.expiresAt })
    } catch {
      setSnapshotStatus({ kind: 'error', message: 'snapshot creation failed' })
    }
  }

  return (
    <div
      id="session_organizer"
      className="relative overflow-hidden rounded-xl border p-3 scroll-mt-4"
      style={{
        background: 'var(--theme-card)',
        borderColor: 'var(--theme-border)',
      }}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <HugeiconsIcon
            icon={Folder01Icon}
            size={14}
            strokeWidth={1.5}
            style={{ color: 'var(--theme-muted)' }}
          />
          <div>
            <h3
              className="text-[10px] font-semibold uppercase tracking-[0.18em]"
              style={{ color: 'var(--theme-text)' }}
            >
              Session Organizer
            </h3>
            <p
              className="text-[8px] leading-tight"
              style={{ color: 'var(--theme-muted)' }}
            >
              Hermes Agent-wide history &mdash; separate from the chat sidebar
            </p>
          </div>
        </div>
        <div className="flex gap-1">
          <button
            type="button"
            className="rounded px-1.5 py-0.5 text-[9px]"
            style={{ color: 'var(--theme-muted)', border: '1px solid var(--theme-border)' }}
            onClick={() => exportCurrentView('json')}
          >
            JSON
          </button>
          <button
            type="button"
            className="rounded px-1.5 py-0.5 text-[9px]"
            style={{ color: 'var(--theme-muted)', border: '1px solid var(--theme-border)' }}
            onClick={() => exportCurrentView('markdown')}
          >
            MD
          </button>
        </div>
      </div>

      <div className="mb-2 flex flex-wrap gap-1">
        <input
          value={filters.project}
          onChange={(e) =>
            setFilters((prev) => ({ ...prev, project: e.target.value }))
          }
          placeholder="Project filter"
          className="w-24 rounded px-1.5 py-0.5 text-[10px]"
          style={{
            background: 'var(--theme-bg)',
            color: 'var(--theme-text)',
            border: '1px solid var(--theme-border)',
          }}
        />
        <input
          value={filters.tag}
          onChange={(e) =>
            setFilters((prev) => ({ ...prev, tag: e.target.value }))
          }
          placeholder="Tag filter"
          className="w-20 rounded px-1.5 py-0.5 text-[10px]"
          style={{
            background: 'var(--theme-bg)',
            color: 'var(--theme-text)',
            border: '1px solid var(--theme-border)',
          }}
        />
        <label
          className="flex items-center gap-1 text-[9px]"
          style={{ color: 'var(--theme-muted)' }}
        >
          <input
            type="checkbox"
            checked={filters.showArchived}
            onChange={(e) =>
              setFilters((prev) => ({
                ...prev,
                showArchived: e.target.checked,
              }))
            }
          />
          Archived
        </label>
      </div>

      {loading ? (
        <div
          className="py-3 text-center text-[11px]"
          style={{ color: 'var(--theme-muted)' }}
        >
          Loading…
        </div>
      ) : data?.error ? (
        <div
          className="py-3 text-center text-[11px]"
          style={{ color: 'var(--theme-danger)' }}
        >
          {data.error}
        </div>
      ) : sessions.length === 0 ? (
        <div
          className="py-3 text-center text-[11px]"
          style={{ color: 'var(--theme-muted)' }}
        >
          No sessions match the current filters.
        </div>
      ) : (
        <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto text-[11px]">
          {sessions.map((session) => (
            <li
              key={session.id}
              className="flex items-center justify-between gap-2 rounded px-1.5 py-1"
              style={{ background: 'var(--theme-bg)' }}
            >
              <div className="min-w-0 flex-1">
                <div
                  className="truncate"
                  style={{ color: 'var(--theme-text)' }}
                >
                  {session.title ?? 'Untitled session'}
                </div>
                {session.metadata.project ? (
                  <div
                    className="truncate text-[9px]"
                    style={{ color: 'var(--theme-muted)' }}
                  >
                    {session.metadata.project}
                  </div>
                ) : null}
              </div>
              <div className="flex shrink-0 gap-1">
                <button
                  type="button"
                  aria-label={session.metadata.pinned ? 'Unpin' : 'Pin'}
                  onClick={() =>
                    mutateSession(session.id, {
                      pinned: !session.metadata.pinned,
                    })
                  }
                  className="rounded px-1 text-[9px]"
                  style={{
                    color: session.metadata.pinned
                      ? 'var(--theme-accent)'
                      : 'var(--theme-muted)',
                  }}
                >
                  {session.metadata.pinned ? '★' : '☆'}
                </button>
                <button
                  type="button"
                  aria-label={
                    session.metadata.archived ? 'Unarchive' : 'Archive'
                  }
                  onClick={() =>
                    mutateSession(session.id, {
                      archived: !session.metadata.archived,
                    })
                  }
                  className="rounded px-1 text-[9px]"
                  style={{ color: 'var(--theme-muted)' }}
                >
                  {session.metadata.archived ? '⤴' : '🗄'}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-2 border-t pt-2" style={{ borderColor: 'var(--theme-border)' }}>
        {snapshotStatus.kind === 'ready' ? (
          <div className="text-[9px]" style={{ color: 'var(--theme-muted)' }}>
            Share link (Tailscale-only, expires{' '}
            {new Date(snapshotStatus.expiresAt).toLocaleString()}):
            <div className="mt-1 truncate">
              <a
                href={snapshotStatus.url}
                target="_blank"
                rel="noreferrer"
                style={{ color: 'var(--theme-accent)' }}
              >
                {snapshotStatus.url}
              </a>
            </div>
          </div>
        ) : snapshotStatus.kind === 'error' ? (
          <div className="text-[9px]" style={{ color: 'var(--theme-danger)' }}>
            {snapshotStatus.message}
          </div>
        ) : (
          <button
            type="button"
            onClick={createShareLink}
            disabled={snapshotStatus.kind === 'creating'}
            className="rounded px-1.5 py-0.5 text-[9px]"
            style={{
              color: 'var(--theme-muted)',
              border: '1px solid var(--theme-border)',
            }}
          >
            {snapshotStatus.kind === 'creating'
              ? 'Creating…'
              : 'Create Tailscale share link (current filters)'}
          </button>
        )}
      </div>
    </div>
  )
}
