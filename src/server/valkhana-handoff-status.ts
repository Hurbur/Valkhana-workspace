export const HANDOFF_STATUS_VERSION = 1 as const
export const HANDOFF_STATES = [
  'idle',
  'brain-working',
  'ready-for-terminal',
  'terminal-working',
  'blocked',
  'complete',
] as const

export type HandoffState = (typeof HANDOFF_STATES)[number]
export type HandoffActor = 'system' | 'brain' | 'terminal'

export interface HandoffStatus {
  version: typeof HANDOFF_STATUS_VERSION
  profileId: string
  updatedAt: string
  actor: HandoffActor
  state: HandoffState
  summary?: string
  nextAction?: string
  blocker?: string
  sourceRef?: string
}

export interface HandoffStatusPatch {
  state: HandoffState
  summary?: string
  nextAction?: string
  blocker?: string
}

/** Source references are accepted only by the dedicated server-local Brain writer. */
export interface BrainHandoffStatusPatch extends HandoffStatusPatch {
  sourceRef?: string
}

export class ValkhanaHandoffStatusError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ValkhanaHandoffStatusError'
  }
}

const MAX_TEXT_LENGTH = 2_000
const STALE_AFTER_MS = 15 * 60 * 1_000

function isoTime(now: Date): string {
  if (Number.isNaN(now.getTime())) {
    throw new ValkhanaHandoffStatusError('updated time is invalid')
  }
  return now.toISOString()
}

function normalizeText(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw new ValkhanaHandoffStatusError(`${field} must be a string`)
  }
  const normalized = value.trim()
  if (!normalized) return undefined
  if (normalized.length > MAX_TEXT_LENGTH) {
    throw new ValkhanaHandoffStatusError(`${field} is too long`)
  }
  return normalized
}

function assertState(value: unknown): asserts value is HandoffState {
  if (!(HANDOFF_STATES as ReadonlyArray<string>).includes(String(value))) {
    throw new ValkhanaHandoffStatusError('state is invalid')
  }
}

function assertActor(value: unknown): asserts value is HandoffActor {
  if (value !== 'system' && value !== 'brain' && value !== 'terminal') {
    throw new ValkhanaHandoffStatusError('actor is invalid')
  }
}

export function createInitialHandoffStatus(
  profileId: string,
  now = new Date(),
): HandoffStatus {
  const normalizedProfileId = profileId.trim()
  if (!normalizedProfileId) {
    throw new ValkhanaHandoffStatusError('profile ID is required')
  }
  return {
    version: HANDOFF_STATUS_VERSION,
    profileId: normalizedProfileId,
    updatedAt: isoTime(now),
    actor: 'system',
    state: 'idle',
  }
}

export function parseHandoffStatus(value: unknown): HandoffStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValkhanaHandoffStatusError('handoff status must be an object')
  }
  const record = value as Record<string, unknown>
  if (record.version !== HANDOFF_STATUS_VERSION) {
    throw new ValkhanaHandoffStatusError('handoff status version is unsupported')
  }
  if (typeof record.profileId !== 'string' || !record.profileId.trim()) {
    throw new ValkhanaHandoffStatusError('handoff status profile ID is invalid')
  }
  if (typeof record.updatedAt !== 'string' || Number.isNaN(Date.parse(record.updatedAt))) {
    throw new ValkhanaHandoffStatusError('handoff status updated time is invalid')
  }
  assertActor(record.actor)
  assertState(record.state)

  return {
    version: HANDOFF_STATUS_VERSION,
    profileId: record.profileId.trim(),
    updatedAt: new Date(record.updatedAt).toISOString(),
    actor: record.actor,
    state: record.state,
    summary: normalizeText(record.summary, 'summary'),
    nextAction: normalizeText(record.nextAction, 'next action'),
    blocker: normalizeText(record.blocker, 'blocker'),
    sourceRef: normalizeText(record.sourceRef, 'source reference'),
  }
}

export function parseHandoffStatusPatch(value: unknown): HandoffStatusPatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValkhanaHandoffStatusError('handoff patch must be an object')
  }
  const record = value as Record<string, unknown>
  const allowedKeys = new Set([
    'state',
    'summary',
    'nextAction',
    'blocker',
  ])
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      throw new ValkhanaHandoffStatusError(`handoff patch field is not allowed: ${key}`)
    }
  }
  assertState(record.state)
  return {
    state: record.state,
    summary: normalizeText(record.summary, 'summary'),
    nextAction: normalizeText(record.nextAction, 'next action'),
    blocker: normalizeText(record.blocker, 'blocker'),
  }
}

export function parseBrainHandoffStatusPatch(
  value: unknown,
): BrainHandoffStatusPatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValkhanaHandoffStatusError('handoff patch must be an object')
  }
  const record = value as Record<string, unknown>
  const allowedKeys = new Set([
    'state',
    'summary',
    'nextAction',
    'blocker',
    'sourceRef',
  ])
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      throw new ValkhanaHandoffStatusError(`handoff patch field is not allowed: ${key}`)
    }
  }
  assertState(record.state)
  return {
    state: record.state,
    summary: normalizeText(record.summary, 'summary'),
    nextAction: normalizeText(record.nextAction, 'next action'),
    blocker: normalizeText(record.blocker, 'blocker'),
    sourceRef: normalizeText(record.sourceRef, 'source reference'),
  }
}

const ACTOR_TRANSITIONS: Record<HandoffActor, Record<HandoffState, ReadonlyArray<HandoffState>>> = {
  system: {
    idle: ['idle'],
    'brain-working': ['brain-working'],
    'ready-for-terminal': ['ready-for-terminal'],
    'terminal-working': ['terminal-working'],
    blocked: ['blocked'],
    complete: ['complete'],
  },
  brain: {
    idle: ['brain-working'],
    'brain-working': ['brain-working', 'ready-for-terminal'],
    'ready-for-terminal': ['brain-working', 'ready-for-terminal'],
    'terminal-working': [],
    blocked: ['brain-working'],
    complete: ['brain-working'],
  },
  terminal: {
    idle: [],
    'brain-working': [],
    'ready-for-terminal': ['terminal-working', 'blocked'],
    'terminal-working': ['terminal-working', 'blocked', 'complete'],
    blocked: ['terminal-working'],
    complete: [],
  },
}

export function applyHandoffStatusPatch(
  current: HandoffStatus,
  patch: HandoffStatusPatch,
  actor: HandoffActor,
  now = new Date(),
): HandoffStatus {
  const normalizedCurrent = parseHandoffStatus(current)
  assertActor(actor)
  const normalizedPatch =
    actor === 'brain'
      ? parseBrainHandoffStatusPatch(patch)
      : parseHandoffStatusPatch(patch)
  if (!ACTOR_TRANSITIONS[actor][normalizedCurrent.state].includes(normalizedPatch.state)) {
    throw new ValkhanaHandoffStatusError(
      `${actor} cannot transition ${normalizedCurrent.state} to ${normalizedPatch.state}`,
    )
  }

  return {
    ...normalizedCurrent,
    ...normalizedPatch,
    updatedAt: isoTime(now),
    actor,
  }
}

export function isHandoffStatusStale(
  status: HandoffStatus,
  now = new Date(),
): boolean {
  const updatedAt = Date.parse(status.updatedAt)
  return Number.isNaN(updatedAt) || now.getTime() - updatedAt >= STALE_AFTER_MS
}
