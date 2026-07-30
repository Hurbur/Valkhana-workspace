import { useEffect, useState } from 'react'
import { HugeiconsIcon } from '@hugeicons/react'
import { Task01Icon } from '@hugeicons/core-free-icons'
import type { ValkhanaBriefingData } from '@/server/valkhana-dashboard-adapter'

type BriefingResponse = Partial<ValkhanaBriefingData> & {
  errors?: Record<string, string>
  error?: string
}

/**
 * Daily project-briefing card: active profile, real session stats, and
 * pending cron jobs pulled from the actual Hermes Agent dashboard via the
 * valkhana-read plugin. Each section renders independently — a missing
 * section (unreachable dashboard, plugin not enabled yet) just hides that
 * part rather than breaking the whole card. See
 * `src/routes/api/dashboard/valkhana-briefing.ts` for the aggregation.
 */
export function DailyBriefingCard() {
  const [briefing, setBriefing] = useState<BriefingResponse | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await fetch('/api/dashboard/valkhana-briefing')
        const data = (await res.json()) as BriefingResponse
        if (!cancelled) setBriefing(data)
      } catch {
        if (!cancelled) setBriefing({ error: 'failed to load briefing' })
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    const interval = setInterval(load, 60_000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  const activeProfileName =
    (briefing?.activeProfile as { name?: string; id?: string } | null)
      ?.name ??
    (briefing?.activeProfile as { name?: string; id?: string } | null)?.id ??
    null
  const cronJobs = briefing?.cronJobs ?? []
  const pendingCron = cronJobs.filter(
    (j) => (j as { status?: string }).status !== 'done',
  )

  return (
    <div
      className="relative overflow-hidden rounded-xl border p-3"
      style={{
        background: 'var(--theme-card)',
        borderColor: 'var(--theme-border)',
      }}
    >
      <div className="mb-2 flex items-center gap-2">
        <HugeiconsIcon
          icon={Task01Icon}
          size={14}
          strokeWidth={1.5}
          style={{ color: 'var(--theme-muted)' }}
        />
        <h3
          className="text-[10px] font-semibold uppercase tracking-[0.18em]"
          style={{ color: 'var(--theme-text)' }}
        >
          Daily Briefing
        </h3>
      </div>

      {loading ? (
        <div
          className="py-3 text-center text-[11px]"
          style={{ color: 'var(--theme-muted)' }}
        >
          Loading…
        </div>
      ) : briefing?.error ? (
        <div
          className="py-3 text-center text-[11px]"
          style={{ color: 'var(--theme-danger)' }}
        >
          {briefing.error}
        </div>
      ) : (
        <div
          className="flex flex-col gap-2 text-[11px]"
          style={{ color: 'var(--theme-text)' }}
        >
          <div>
            <span style={{ color: 'var(--theme-muted)' }}>
              Active profile:{' '}
            </span>
            {activeProfileName ?? '—'}
          </div>
          <div>
            <span style={{ color: 'var(--theme-muted)' }}>
              Profiles registered:{' '}
            </span>
            {briefing?.profiles?.length ?? 0}
          </div>
          <div>
            <span style={{ color: 'var(--theme-muted)' }}>
              Cron jobs pending:{' '}
            </span>
            {pendingCron.length} / {cronJobs.length}
          </div>
          {briefing?.errors && Object.keys(briefing.errors).length > 0 ? (
            <div
              className="mt-1 text-[9px]"
              style={{ color: 'var(--theme-muted)' }}
            >
              Some sections unavailable: {Object.keys(briefing.errors).join(', ')}
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}
