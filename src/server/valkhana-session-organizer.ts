export type SessionOrganizerMetadata = {
  pinned: boolean
  archived: boolean
  project: string | null
  tags: Array<string>
  updatedAt: string
}

export type SessionOrganizer = {
  version: 1
  profileId: string
  updatedAt: string
  sessions: Record<string, SessionOrganizerMetadata>
}

export type SessionOrganizerPatch = {
  sessionId: string
  pinned?: boolean
  archived?: boolean
  project?: string | null
  tags?: Array<string>
}

export class ValkhanaSessionOrganizerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ValkhanaSessionOrganizerError'
  }
}

const PATCH_FIELDS = new Set([
  'sessionId',
  'pinned',
  'archived',
  'project',
  'tags',
])
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValkhanaSessionOrganizerError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function requiredIsoDate(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !value ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new ValkhanaSessionOrganizerError(`${label} must be an ISO timestamp`)
  }
  return new Date(value).toISOString()
}

function stableSessionId(value: unknown): string {
  if (typeof value !== 'string' || !SESSION_ID_PATTERN.test(value)) {
    throw new ValkhanaSessionOrganizerError('sessionId is not a stable session id')
  }
  return value
}

function normalizedProject(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') {
    throw new ValkhanaSessionOrganizerError('project must be a string or null')
  }
  const project = value.trim()
  if (project.length > 80) {
    throw new ValkhanaSessionOrganizerError('project must be 80 characters or fewer')
  }
  return project || null
}

function normalizedTags(value: unknown): Array<string> {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 12) {
    throw new ValkhanaSessionOrganizerError('tags must contain at most 12 strings')
  }
  const tags: Array<string> = []
  for (const candidate of value) {
    if (typeof candidate !== 'string') {
      throw new ValkhanaSessionOrganizerError('tags must contain only strings')
    }
    const tag = candidate.trim().toLowerCase()
    if (!tag) continue
    if (tag.length > 32) {
      throw new ValkhanaSessionOrganizerError('each tag must be 32 characters or fewer')
    }
    if (!tags.includes(tag)) tags.push(tag)
  }
  return tags
}

function parseMetadata(value: unknown): SessionOrganizerMetadata {
  const record = objectRecord(value, 'session metadata')
  return {
    pinned: record.pinned === true,
    archived: record.archived === true,
    project: normalizedProject(record.project),
    tags: normalizedTags(record.tags),
    updatedAt: requiredIsoDate(record.updatedAt, 'metadata updatedAt'),
  }
}

export function createSessionOrganizer(
  profileId: string,
  now = new Date(),
): SessionOrganizer {
  if (!profileId.trim()) {
    throw new ValkhanaSessionOrganizerError('profileId is required')
  }
  return {
    version: 1,
    profileId,
    updatedAt: now.toISOString(),
    sessions: {},
  }
}

export function parseSessionOrganizer(
  value: unknown,
  profileId: string,
): SessionOrganizer {
  const record = objectRecord(value, 'session organizer')
  if (record.version !== 1) {
    throw new ValkhanaSessionOrganizerError('unsupported session organizer version')
  }
  if (record.profileId !== profileId) {
    throw new ValkhanaSessionOrganizerError(
      'session organizer belongs to a different profile',
    )
  }
  const rawSessions = objectRecord(record.sessions, 'sessions')
  const sessions: Record<string, SessionOrganizerMetadata> = {}
  for (const [sessionId, metadata] of Object.entries(rawSessions)) {
    sessions[stableSessionId(sessionId)] = parseMetadata(metadata)
  }
  return {
    version: 1,
    profileId,
    updatedAt: requiredIsoDate(record.updatedAt, 'organizer updatedAt'),
    sessions,
  }
}

export function parseSessionOrganizerPatch(
  value: unknown,
): SessionOrganizerPatch {
  const record = objectRecord(value, 'session organizer patch')
  for (const field of Object.keys(record)) {
    if (!PATCH_FIELDS.has(field)) {
      throw new ValkhanaSessionOrganizerError(`unsupported field: ${field}`)
    }
  }
  const patch: SessionOrganizerPatch = {
    sessionId: stableSessionId(record.sessionId),
  }
  let hasMutation = false
  if ('pinned' in record) {
    if (typeof record.pinned !== 'boolean') {
      throw new ValkhanaSessionOrganizerError('pinned must be boolean')
    }
    patch.pinned = record.pinned
    hasMutation = true
  }
  if ('archived' in record) {
    if (typeof record.archived !== 'boolean') {
      throw new ValkhanaSessionOrganizerError('archived must be boolean')
    }
    patch.archived = record.archived
    hasMutation = true
  }
  if ('project' in record) {
    patch.project = normalizedProject(record.project)
    hasMutation = true
  }
  if ('tags' in record) {
    patch.tags = normalizedTags(record.tags)
    hasMutation = true
  }
  if (!hasMutation) {
    throw new ValkhanaSessionOrganizerError('patch has no metadata changes')
  }
  return patch
}

export function applySessionOrganizerPatch(
  current: SessionOrganizer,
  patch: SessionOrganizerPatch,
  now = new Date(),
): SessionOrganizer {
  const updatedAt = now.toISOString()
  const previous = current.sessions[patch.sessionId]
  return {
    ...current,
    updatedAt,
    sessions: {
      ...current.sessions,
      [patch.sessionId]: {
        pinned: patch.pinned ?? previous?.pinned ?? false,
        archived: patch.archived ?? previous?.archived ?? false,
        project:
          patch.project !== undefined
            ? patch.project
            : (previous?.project ?? null),
        tags: patch.tags ?? previous?.tags ?? [],
        updatedAt,
      },
    },
  }
}

export function filterOrganizedSessions<
  T extends {
    id: string
    metadata: Pick<
      SessionOrganizerMetadata,
      'pinned' | 'archived' | 'project' | 'tags'
    >
  },
>(
  sessions: Array<T>,
  filters: {
    sessionId?: string
    project?: string
    tag?: string
    archived?: boolean
    pinned?: boolean
  },
): Array<T> {
  const project = filters.project?.trim().toLowerCase()
  const tag = filters.tag?.trim().toLowerCase()
  return sessions.filter((session) => {
    if (filters.sessionId && session.id !== filters.sessionId) {
      return false
    }
    if (
      project &&
      session.metadata.project?.trim().toLowerCase() !== project
    ) {
      return false
    }
    if (
      tag &&
      !session.metadata.tags.some((candidate) => candidate.toLowerCase() === tag)
    ) {
      return false
    }
    if (
      filters.archived !== undefined &&
      session.metadata.archived !== filters.archived
    ) {
      return false
    }
    if (
      filters.pinned !== undefined &&
      session.metadata.pinned !== filters.pinned
    ) {
      return false
    }
    return true
  })
}
