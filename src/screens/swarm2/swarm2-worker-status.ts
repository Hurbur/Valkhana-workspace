import type { CrewMember } from '@/hooks/use-crew-status'
import { getOnlineStatus } from '@/hooks/use-crew-status'

export type Swarm2WorkerState =
  | 'active'
  | 'idle'
  | 'error'
  | 'offline'
  | 'thinking'
  | 'writing'
  | 'reviewing'
  | 'waiting'

/**
 * Canonical worker-state precedence shared by card and topology views.
 * Runtime/checkpoint signals win over the less reliable task-title heuristic.
 */
export function deriveSwarm2WorkerState(
  member: CrewMember,
  currentTask: string | null,
  checkpointStatus?: string | null,
  runtimeState?: string | null,
): Swarm2WorkerState {
  const status = getOnlineStatus(member)
  if (status === 'offline') return 'offline'

  const cs = checkpointStatus ?? null
  const rs = runtimeState ?? null
  if (cs === 'done' || cs === 'handoff' || rs === 'idle') return 'idle'
  if (cs === 'blocked' || rs === 'blocked') return 'error'
  if (cs === 'needs_input' || rs === 'waiting') return 'waiting'
  if (!currentTask) return 'idle'
  if (cs && cs !== 'none' && cs !== 'in_progress') return 'idle'

  const task = currentTask.toLowerCase()
  if (task.includes('review')) return 'reviewing'
  if (task.includes('writ') || task.includes('doc') || task.includes('spec')) return 'writing'
  if (task.includes('research') || task.includes('plan') || task.includes('think')) return 'thinking'
  if (task.includes('wait') || task.includes('approval')) return 'waiting'
  if (task.includes('block') || task.includes('error') || task.includes('fail')) return 'error'
  return 'active'
}
