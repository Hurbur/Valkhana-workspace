import { useQuery } from '@tanstack/react-query'
import { getValKhanaCoreState } from '@/lib/valkhana-core'

export function ValKhanaCoreStatus() {
  const query = useQuery({
    queryKey: ['valkhana', 'core', 'health'],
    queryFn: getValKhanaCoreState,
    staleTime: 5_000,
    refetchInterval: 10_000,
    retry: false,
  })

  const state = query.data
  const online = state?.kind === 'online'
  const checking = query.isPending
  const label = checking
    ? 'core checking'
    : online
      ? 'core online'
      : state?.kind === 'web'
        ? 'core desktop bridge'
        : 'core offline'
  const detail = online
    ? `ValKhana Core v${state.health.version}`
    : state?.message || 'Checking ValKhana Core health'
  const tone = checking
    ? 'var(--theme-muted)'
    : online
      ? 'var(--theme-success)'
      : state?.kind === 'web'
        ? 'var(--theme-muted)'
        : 'var(--theme-danger)'

  return (
    <div
      className="flex items-center justify-between gap-3 rounded-md border bg-[var(--theme-card)]/50 px-3 py-2"
      style={{ borderColor: 'var(--theme-border)' }}
      role="status"
      aria-live="polite"
    >
      <span className="flex items-center gap-2">
        <span
          className={`inline-flex size-1.5 rounded-full ${online ? 'animate-pulse' : ''}`}
          style={{ background: tone }}
        />
        <span
          className="font-mono text-[10px] uppercase tracking-[0.15em]"
          style={{ color: tone }}
        >
          {label}
        </span>
      </span>
      <span
        className="truncate font-mono text-[9px] uppercase tracking-[0.1em]"
        style={{ color: 'var(--theme-muted)' }}
        title={detail}
      >
        {detail}
      </span>
    </div>
  )
}
