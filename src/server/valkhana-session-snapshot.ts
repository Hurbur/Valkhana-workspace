import { randomBytes } from 'node:crypto'
import {
  resolveActiveProfileStore,
  type ValkhanaProfileStore,
} from './valkhana-profile-store'
import {
  exportActiveOrganizedSessions,
  type SessionOrganizerFilters,
} from './valkhana-session-service'

export class ValkhanaSessionSnapshotError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ValkhanaSessionSnapshotError'
  }
}

export interface SessionSnapshotRecord {
  id: string
  profileId: string
  format: 'json' | 'markdown'
  contentType: string
  filename: string
  body: string
  createdAt: string
  expiresAt: string
}

type SnapshotFile = {
  version: 1
  snapshots: Record<string, SessionSnapshotRecord>
}

const MAX_TTL_HOURS = 24 * 7
const DEFAULT_TTL_HOURS = 24
// 256 bits of entropy for the capability id, matching this project's existing
// auth-secret entropy bar (see the reverted valkhana-read plugin's bearer
// token, which used the same 256-bit floor).
const CAPABILITY_BYTES = 32
const CAPABILITY_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/

function capabilityId(): string {
  return randomBytes(CAPABILITY_BYTES).toString('base64url')
}

function isExpired(record: SessionSnapshotRecord, now: Date): boolean {
  return Date.parse(record.expiresAt) <= now.getTime()
}

function parseSnapshotFile(raw: unknown): SnapshotFile {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { version: 1, snapshots: {} }
  }
  const record = raw as Record<string, unknown>
  if (
    record.version !== 1 ||
    !record.snapshots ||
    typeof record.snapshots !== 'object' ||
    Array.isArray(record.snapshots)
  ) {
    return { version: 1, snapshots: {} }
  }
  return {
    version: 1,
    snapshots: record.snapshots as Record<string, SessionSnapshotRecord>,
  }
}

async function readSnapshotFile(
  store: ValkhanaProfileStore,
): Promise<SnapshotFile> {
  return parseSnapshotFile(await store.readJson('session-snapshots.json'))
}

function pruneExpired(file: SnapshotFile, now: Date): SnapshotFile {
  const snapshots: Record<string, SessionSnapshotRecord> = {}
  for (const [id, record] of Object.entries(file.snapshots)) {
    if (!isExpired(record, now)) snapshots[id] = record
  }
  return { version: 1, snapshots }
}

type SnapshotDependencies = {
  resolveStore?: () => Promise<ValkhanaProfileStore>
  now?: () => Date
}

/**
 * Creates a capability-addressed, read-only export snapshot for the active
 * profile. The snapshot body is the same sanitized projection used by the
 * authenticated export route (`exportActiveOrganizedSessions`) — messages,
 * prompts, and credentials never enter the snapshot store.
 */
export async function createSessionSnapshot(
  format: 'json' | 'markdown',
  filters: SessionOrganizerFilters = {},
  options: SnapshotDependencies & { ttlHours?: number } = {},
): Promise<{ id: string; expiresAt: string }> {
  const resolveStore = options.resolveStore ?? resolveActiveProfileStore
  const now = options.now?.() ?? new Date()
  const ttlHours = Math.min(
    MAX_TTL_HOURS,
    Math.max(1, Math.trunc(options.ttlHours ?? DEFAULT_TTL_HOURS)),
  )
  const store = await resolveStore()
  const exported = await exportActiveOrganizedSessions(format, filters, {
    now: () => now,
  })
  const id = capabilityId()
  const expiresAt = new Date(
    now.getTime() + ttlHours * 60 * 60 * 1000,
  ).toISOString()

  const existing = pruneExpired(await readSnapshotFile(store), now)
  const updated: SnapshotFile = {
    version: 1,
    snapshots: {
      ...existing.snapshots,
      [id]: {
        id,
        profileId: store.profile.id,
        format,
        contentType: exported.contentType,
        filename: exported.filename,
        body: exported.body,
        createdAt: now.toISOString(),
        expiresAt,
      },
    },
  }
  await store.writeJson('session-snapshots.json', updated)
  return { id, expiresAt }
}

/**
 * Reads a snapshot by capability id. Returns null for a missing or expired
 * snapshot — callers must not distinguish "never existed" from "expired" in
 * their response, so an unguessable id that has simply aged out reveals
 * nothing more than one that was never issued.
 */
export async function readSessionSnapshot(
  id: string,
  options: SnapshotDependencies = {},
): Promise<SessionSnapshotRecord | null> {
  if (!CAPABILITY_ID_PATTERN.test(id)) {
    throw new ValkhanaSessionSnapshotError('invalid snapshot id')
  }
  const resolveStore = options.resolveStore ?? resolveActiveProfileStore
  const now = options.now?.() ?? new Date()
  const store = await resolveStore()
  const file = await readSnapshotFile(store)
  const record = file.snapshots[id]
  if (!record || isExpired(record, now)) return null
  return record
}
