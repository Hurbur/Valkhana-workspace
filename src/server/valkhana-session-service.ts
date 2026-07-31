import type {
  ValkhanaSession,
  ValkhanaSessionPage,
} from './valkhana-dashboard-adapter'
import {
  fetchValkhanaSessionDetail,
  fetchValkhanaSessions,
} from './valkhana-dashboard-adapter'
import {
  applySessionOrganizerPatch,
  createSessionOrganizer,
  filterOrganizedSessions,
  parseSessionOrganizer,
  parseSessionOrganizerPatch,
  type SessionOrganizer,
  SessionOrganizerMetadata,
  type SessionOrganizerPatch,
} from './valkhana-session-organizer'
import {
  resolveActiveProfileStore,
  type ValkhanaProfileStore,
} from './valkhana-profile-store'

export type OrganizedSession = ValkhanaSession & {
  metadata: Omit<SessionOrganizerMetadata, 'updatedAt'> & {
    updatedAt: string | null
  }
}

export type SessionOrganizerFilters = {
  project?: string
  tag?: string
  archived?: boolean
  pinned?: boolean
}

type Dependencies = {
  resolveStore?: () => Promise<ValkhanaProfileStore>
  fetchSessions?: (options: {
    profile: string
    limit?: number
    offset?: number
  }) => Promise<ValkhanaSessionPage>
  fetchDetail?: (
    sessionId: string,
    profile: string,
  ) => Promise<ValkhanaSession>
  now?: () => Date
}

const mutationTails = new Map<string, Promise<void>>()

async function withProfileMutation<T>(
  profileId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = mutationTails.get(profileId) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  mutationTails.set(profileId, current)
  await previous
  try {
    return await operation()
  } finally {
    release()
    if (mutationTails.get(profileId) === current) mutationTails.delete(profileId)
  }
}

async function readOrganizer(
  store: ValkhanaProfileStore,
  now: Date,
): Promise<SessionOrganizer> {
  const raw = await store.readJson('session-organizer.json')
  return raw
    ? parseSessionOrganizer(raw, store.profile.id)
    : createSessionOrganizer(store.profile.id, now)
}

async function fetchAllSessions(
  profile: string,
  fetchPage: NonNullable<Dependencies['fetchSessions']>,
): Promise<Array<ValkhanaSession>> {
  const sessions: Array<ValkhanaSession> = []
  let offset = 0
  let pages = 0
  while (true) {
    const page = await fetchPage({ profile, limit: 100, offset })
    sessions.push(...page.sessions)
    offset += page.sessions.length
    if (offset >= page.total) return sessions
    if (page.sessions.length === 0 || ++pages > 1_000) {
      throw new Error('dashboard session pagination did not make progress')
    }
  }
}

function joinedMetadata(
  metadata: SessionOrganizerMetadata | undefined,
): OrganizedSession['metadata'] {
  return metadata
    ? { ...metadata }
    : {
        pinned: false,
        archived: false,
        project: null,
        tags: [],
        updatedAt: null,
      }
}

function joinSessions(
  sessions: Array<ValkhanaSession>,
  organizer: SessionOrganizer,
): Array<OrganizedSession> {
  return sessions
    .map((session) => ({
      ...session,
      metadata: joinedMetadata(organizer.sessions[session.id]),
    }))
    .sort(
      (left, right) =>
        Number(right.metadata.pinned) - Number(left.metadata.pinned) ||
        right.lastActive - left.lastActive,
    )
}

function safeMarkdownText(value: string | null): string {
  if (!value) return 'Untitled session'
  return value.replace(/[\r\n\t]+/g, ' ').replace(/[#*_`[\]<>]/g, '\\$&').trim()
}

function exportProjection(session: OrganizedSession) {
  return {
    id: session.id,
    title: session.title,
    source: session.source,
    model: session.model,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    lastActive: session.lastActive,
    active: session.active,
    messageCount: session.messageCount,
    toolCallCount: session.toolCallCount,
    inputTokens: session.inputTokens,
    outputTokens: session.outputTokens,
    metadata: {
      pinned: session.metadata.pinned,
      archived: session.metadata.archived,
      project: session.metadata.project,
      tags: [...session.metadata.tags],
      updatedAt: session.metadata.updatedAt,
    },
  }
}

export async function readActiveOrganizedSessions(
  filters: SessionOrganizerFilters = {},
  dependencies: Dependencies = {},
): Promise<{
  profile: { id: string; name: string }
  sessions: Array<OrganizedSession>
  total: number
}> {
  const resolveStore = dependencies.resolveStore ?? resolveActiveProfileStore
  const fetchSessions = dependencies.fetchSessions ?? fetchValkhanaSessions
  const now = dependencies.now?.() ?? new Date()
  const store = await resolveStore()
  const [organizer, sessions] = await Promise.all([
    readOrganizer(store, now),
    fetchAllSessions(store.profile.id, fetchSessions),
  ])
  const filtered = filterOrganizedSessions(
    joinSessions(sessions, organizer),
    filters,
  )
  return {
    profile: { id: store.profile.id, name: store.profile.name },
    sessions: filtered,
    total: filtered.length,
  }
}

export async function mutateActiveSessionOrganizer(
  patch: SessionOrganizerPatch,
  dependencies: Dependencies = {},
): Promise<OrganizedSession['metadata']> {
  const resolveStore = dependencies.resolveStore ?? resolveActiveProfileStore
  const fetchDetail = dependencies.fetchDetail ?? fetchValkhanaSessionDetail
  const parsedPatch = parseSessionOrganizerPatch(patch)
  const store = await resolveStore()

  await fetchDetail(parsedPatch.sessionId, store.profile.id)

  return withProfileMutation(store.profile.id, async () => {
    const now = dependencies.now?.() ?? new Date()
    const organizer = await readOrganizer(store, now)
    const updated = applySessionOrganizerPatch(organizer, parsedPatch, now)
    await store.writeJson('session-organizer.json', updated)
    return joinedMetadata(updated.sessions[parsedPatch.sessionId])
  })
}

export async function exportActiveOrganizedSessions(
  format: 'json' | 'markdown',
  filters: SessionOrganizerFilters = {},
  dependencies: Dependencies = {},
): Promise<{ body: string; contentType: string; filename: string }> {
  const result = await readActiveOrganizedSessions(filters, dependencies)
  const exportedAt = (dependencies.now?.() ?? new Date()).toISOString()
  const sessions = result.sessions.map(exportProjection)
  const filenameBase = `valkhana-sessions-${result.profile.id.replace(/[^A-Za-z0-9_-]/g, '-')}`

  if (format === 'json') {
    return {
      body: `${JSON.stringify(
        {
          version: 1,
          exportedAt,
          profile: result.profile,
          sessions,
        },
        null,
        2,
      )}\n`,
      contentType: 'application/json; charset=utf-8',
      filename: `${filenameBase}.json`,
    }
  }

  const body = [
    `# Valkhana Sessions — ${safeMarkdownText(result.profile.name)}`,
    '',
    `Exported: ${exportedAt}`,
    '',
    ...sessions.flatMap((session) => [
      `## ${safeMarkdownText(session.title)}`,
      '',
      `- ID: \`${session.id}\``,
      `- Project: ${safeMarkdownText(session.metadata.project)}`,
      `- Tags: ${session.metadata.tags.length ? session.metadata.tags.join(', ') : 'None'}`,
      `- Pinned: ${session.metadata.pinned ? 'yes' : 'no'}`,
      `- Archived: ${session.metadata.archived ? 'yes' : 'no'}`,
      `- Source: ${safeMarkdownText(session.source)}`,
      `- Model: ${safeMarkdownText(session.model)}`,
      `- Messages: ${session.messageCount}`,
      `- Tool calls: ${session.toolCallCount}`,
      `- Last active: ${new Date(session.lastActive * 1_000).toISOString()}`,
      '',
    ]),
  ].join('\n')
  return {
    body: `${body}\n`,
    contentType: 'text/markdown; charset=utf-8',
    filename: `${filenameBase}.md`,
  }
}
