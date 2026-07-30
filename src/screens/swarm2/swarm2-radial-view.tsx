'use client'

import { useLayoutEffect, useRef, useState } from 'react'
import { HugeiconsIcon } from '@hugeicons/react'
import { CheckListIcon, ComputerTerminal01Icon } from '@hugeicons/core-free-icons'
import type { CrewMember } from '@/hooks/use-crew-status'
import { cn } from '@/lib/utils'
import {
  deriveSwarm2WorkerState,
  type Swarm2WorkerState,
} from './swarm2-worker-status'

export type RadialNodePosition = {
  x: number
  y: number
}

/**
 * Positions nodes on a responsive ellipse using percentages, so the topology
 * scales with its container instead of relying on fixed screen coordinates.
 */
export function buildRadialNodePositions(count: number): Array<RadialNodePosition> {
  if (count <= 0) return []
  if (count === 1) return [{ x: 50, y: 82 }]

  return Array.from({ length: count }, (_, index) => {
    const angle = -Math.PI / 2 + (index * Math.PI * 2) / count
    return {
      x: Number((50 + Math.cos(angle) * 32).toFixed(3)),
      y: Number((50 + Math.sin(angle) * 28).toFixed(3)),
    }
  })
}

type RadialRuntime = {
  currentTask: string | null
  state?: string | null
  checkpointStatus?: string | null
  lastOutputAt?: number | null
}

type Swarm2RadialViewProps = {
  members: Array<CrewMember>
  runtimeByWorker: Map<string, RadialRuntime>
  roomIds: Array<string>
  selectedId: string | null
  onSelect: (workerId: string) => void
  onToggleRoom: (workerId: string) => void
  onOpenTui: (workerId: string) => void
  onOpenTasks: (workerId: string) => void
  onWorkerRef: (workerId: string) => (node: HTMLElement | null) => void
  onHubRef: (node: HTMLDivElement | null) => void
}

export function getRadialWorkerStatus(
  member: CrewMember,
  runtime?: RadialRuntime,
): Swarm2WorkerState {
  return deriveSwarm2WorkerState(
    member,
    runtime?.currentTask ?? null,
    runtime?.checkpointStatus,
    runtime?.state,
  )
}

function statusLabel(state: Swarm2WorkerState): string {
  if (state === 'error') return 'Blocked'
  return state[0].toUpperCase() + state.slice(1)
}

function statusClass(state: Swarm2WorkerState): string {
  if (state === 'error') return 'bg-red-500'
  if (state === 'waiting') return 'bg-amber-500'
  if (state === 'active' || state === 'reviewing' || state === 'writing' || state === 'thinking') return 'bg-emerald-500 animate-pulse'
  return state === 'idle' ? 'bg-primary-400' : 'bg-sky-500'
}

export function Swarm2RadialView({
  members,
  runtimeByWorker,
  roomIds,
  selectedId,
  onSelect,
  onToggleRoom,
  onOpenTui,
  onOpenTasks,
  onWorkerRef,
  onHubRef,
}: Swarm2RadialViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [compact, setCompact] = useState(false)
  const positions = buildRadialNodePositions(members.length)

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return undefined
    const observer = new ResizeObserver(([entry]) => {
      setCompact(entry.contentRect.width < 720)
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  if (members.length === 0) {
    return (
      <div className="relative z-10 rounded-[1.5rem] border border-dashed border-[var(--theme-border)] bg-[var(--theme-card)] p-8 text-sm text-[var(--theme-muted)]">
        No swarm workers discovered from crew status yet.
      </div>
    )
  }

  return (
    <section
      ref={containerRef}
      aria-label="Swarm organization view"
      className="relative z-10 min-h-[31rem] overflow-hidden rounded-[1.5rem] border border-[var(--theme-border)] bg-[radial-gradient(circle_at_center,var(--theme-accent-soft),transparent_58%)]"
    >
      <div ref={onHubRef} data-swarm2-anchor="radial-hub" aria-label="Orchestrator hub" className={cn('z-0 flex size-24 items-center justify-center rounded-full border-2 border-[var(--theme-accent)] bg-[var(--theme-card)] text-center text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--theme-accent-strong)] shadow-[0_0_44px_var(--theme-accent-soft-strong)]', compact ? 'relative mx-auto mt-4' : 'absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2')}>
        Orchestrator
      </div>
      <div className={cn(compact ? 'relative z-10 grid grid-cols-1 gap-3 p-4 sm:grid-cols-2' : 'contents')}>
      {members.map((member, index) => {
        const runtime = runtimeByWorker.get(member.id)
        const position = positions[index]
        const selected = member.id === selectedId
        const inRoom = roomIds.includes(member.id)
        const state = getRadialWorkerStatus(member, runtime)
        const status = statusLabel(state)
        const label = member.displayName || member.id
        const task = runtime?.currentTask || member.lastSessionTitle || 'Ready for task'
        return (
          <article
            key={member.id}
            ref={onWorkerRef(member.id)}
            data-swarm2-worker-id={member.id}
            className={cn(
              compact ? 'relative w-full rounded-2xl border bg-[var(--theme-card)] p-3 shadow-[0_14px_34px_var(--theme-shadow)] transition-shadow' : 'absolute z-10 w-44 -translate-x-1/2 -translate-y-1/2 rounded-2xl border bg-[var(--theme-card)] p-3 shadow-[0_14px_34px_var(--theme-shadow)] transition-shadow',
              selected ? 'border-[var(--theme-accent)] ring-1 ring-[var(--theme-accent-soft-strong)]' : inRoom ? 'border-[var(--theme-border2)]' : 'border-[var(--theme-border)]',
              compact && 'w-36 p-2.5',
            )}
            style={compact ? undefined : { left: `${position.x}%`, top: `${position.y}%` }}
          >
            <button
              type="button"
              onClick={() => onSelect(member.id)}
              className="w-full text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--theme-accent)]"
              aria-label={`Select ${label}, ${status}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-xs font-semibold text-[var(--theme-text)]">{label}</span>
                <span className={cn('size-2 shrink-0 rounded-full', statusClass(state))} aria-hidden="true" />
              </div>
              <div className="mt-1 truncate text-[9px] font-semibold uppercase tracking-[0.13em] text-[var(--theme-muted)]">{member.role || 'Worker'} · {status}</div>
              <p className="mt-2 line-clamp-2 min-h-8 text-[10px] leading-snug text-[var(--theme-muted-2)]" title={task}>{task}</p>
            </button>
            <div className="mt-2 flex items-center gap-1 border-t border-[var(--theme-border)] pt-2">
              <button type="button" onClick={() => onToggleRoom(member.id)} className="rounded-md border border-[var(--theme-border)] px-1.5 py-1 text-[9px] text-[var(--theme-muted)] hover:bg-[var(--theme-card2)] hover:text-[var(--theme-text)]">
                {inRoom ? 'In room' : 'Add room'}
              </button>
              <button type="button" onClick={() => onOpenTasks(member.id)} className="ml-auto rounded-md p-1 text-[var(--theme-muted)] hover:bg-[var(--theme-card2)] hover:text-[var(--theme-text)]" aria-label={`Route work to ${label}`} title="Route work">
                <HugeiconsIcon icon={CheckListIcon} size={13} />
              </button>
              <button type="button" onClick={() => onOpenTui(member.id)} className="rounded-md p-1 text-[var(--theme-muted)] hover:bg-[var(--theme-card2)] hover:text-[var(--theme-text)]" aria-label={`Open terminal for ${label}`} title="Open terminal">
                <HugeiconsIcon icon={ComputerTerminal01Icon} size={13} />
              </button>
            </div>
            {selected ? (
              <section role="region" aria-label={`Details for ${label}`} className="mt-2 border-t border-[var(--theme-border)] pt-2 text-[10px] leading-snug text-[var(--theme-muted-2)]">
                <div><span className="font-semibold text-[var(--theme-muted)]">Model:</span> {member.model || member.provider || 'Not reported'}</div>
                <div className="mt-1"><span className="font-semibold text-[var(--theme-muted)]">Mission:</span> {member.mission || member.specialty || 'No mission reported'}</div>
              </section>
            ) : null}
          </article>
        )
      })}
      </div>
    </section>
  )
}
