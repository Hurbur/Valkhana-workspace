import { Task01Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useEffect, useState } from 'react'

export type HandoffCardState =
  | 'idle'
  | 'brain-working'
  | 'ready-for-terminal'
  | 'terminal-working'
  | 'blocked'
  | 'complete'

type HandoffStatus = {
  version: 1
  profileId: string
  updatedAt: string
  actor: 'system' | 'brain' | 'terminal'
  state: HandoffCardState
  summary?: string
  nextAction?: string
  blocker?: string
  sourceRef?: string
}

type HandoffResponse = {
  status: HandoffStatus
  stale: boolean
  error?: string
}

export function terminalActionFor(
  state: HandoffCardState,
): { label: string; state: HandoffCardState } | null {
  if (state === 'ready-for-terminal') {
    return { label: 'Start terminal work', state: 'terminal-working' }
  }
  if (state === 'blocked') {
    return { label: 'Resume terminal work', state: 'terminal-working' }
  }
  return null
}

function formatState(state: HandoffCardState): string {
  return state.replaceAll('-', ' ')
}

function age(updatedAt: string): string {
  const milliseconds = Date.now() - Date.parse(updatedAt)
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return 'just now'
  const seconds = Math.floor(milliseconds / 1_000)
  if (seconds < 60) return 'just now'
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ago`
  return `${Math.floor(seconds / 86_400)}d ago`
}

/** Profile-scoped coordination status; all data comes from the authenticated server route. */
export function HandoffStatusCard() {
  const [data, setData] = useState<HandoffResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [updating, setUpdating] = useState(false)

  const load = async () => {
    try {
      const response = await fetch('/api/dashboard/handoff-status')
      const body = (await response.json()) as HandoffResponse
      setData(response.ok ? body : { ...body, error: body.error || 'failed to load handoff' })
    } catch {
      setData({ error: 'failed to load handoff' } as HandoffResponse)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    const interval = window.setInterval(() => void load(), 60_000)
    return () => window.clearInterval(interval)
  }, [])

  const transition = async (state: HandoffCardState) => {
    setUpdating(true)
    try {
      const response = await fetch('/api/dashboard/handoff-status', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state }),
      })
      const body = (await response.json()) as HandoffResponse
      setData(response.ok ? body : { ...body, error: body.error || 'handoff update failed' })
    } catch {
      setData((current) => ({
        ...(current ?? ({} as HandoffResponse)),
        error: 'handoff update failed',
      }))
    } finally {
      setUpdating(false)
    }
  }

  const status = data?.status
  const primaryAction = status ? terminalActionFor(status.state) : null

  return (
    <div
      className="relative overflow-hidden rounded-xl border p-3"
      style={{ background: 'var(--theme-card)', borderColor: 'var(--theme-border)' }}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <HugeiconsIcon icon={Task01Icon} size={14} strokeWidth={1.5} style={{ color: 'var(--theme-muted)' }} />
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.18em]" style={{ color: 'var(--theme-text)' }}>
            Handoff Status
          </h3>
        </div>
        {status && data?.stale ? (
          <span className="rounded border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.1em]" style={{ color: 'var(--theme-warning)', borderColor: 'var(--theme-warning)' }}>
            Stale
          </span>
        ) : null}
      </div>

      {loading ? (
        <div className="py-3 text-center text-[11px]" style={{ color: 'var(--theme-muted)' }}>Loading…</div>
      ) : data?.error ? (
        <div className="py-3 text-center text-[11px]" style={{ color: 'var(--theme-danger)' }}>{data.error}</div>
      ) : status ? (
        <div className="flex flex-col gap-2 text-[11px]" style={{ color: 'var(--theme-text)' }}>
          <div className="flex items-center justify-between gap-2">
            <span style={{ color: 'var(--theme-muted)' }}>Profile: {status.profileId}</span>
            <span className="capitalize" style={{ color: 'var(--theme-accent)' }}>{formatState(status.state)}</span>
          </div>
          <div style={{ color: 'var(--theme-muted)' }}>Updated {age(status.updatedAt)} by {status.actor}</div>
          {status.summary ? <p>{status.summary}</p> : null}
          {status.nextAction ? <p><span style={{ color: 'var(--theme-muted)' }}>Next: </span>{status.nextAction}</p> : null}
          {status.blocker ? <p style={{ color: 'var(--theme-danger)' }}>Blocked: {status.blocker}</p> : null}
          {primaryAction ? (
            <button type="button" disabled={updating} onClick={() => void transition(primaryAction.state)} className="rounded px-2 py-1 text-left font-semibold disabled:opacity-50" style={{ background: 'var(--theme-accent)', color: 'var(--theme-on-accent, white)' }}>
              {primaryAction.label}
            </button>
          ) : null}
          {status.state === 'terminal-working' ? (
            <div className="flex gap-2">
              <button type="button" disabled={updating} onClick={() => void transition('complete')} className="rounded px-2 py-1 font-semibold disabled:opacity-50" style={{ background: 'var(--theme-success)', color: 'var(--theme-on-accent, white)' }}>
                Mark complete
              </button>
              <button type="button" disabled={updating} onClick={() => void transition('blocked')} className="rounded border px-2 py-1 font-semibold disabled:opacity-50" style={{ borderColor: 'var(--theme-danger)', color: 'var(--theme-danger)' }}>
                Mark blocked
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
