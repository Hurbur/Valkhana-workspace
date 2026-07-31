import { describe, expect, it, vi } from 'vitest'
import type { ValkhanaProfileStore } from './valkhana-profile-store'
import type { ValkhanaSession } from './valkhana-dashboard-adapter'
import {
  exportActiveOrganizedSessions,
  mutateActiveSessionOrganizer,
  readActiveOrganizedSessions,
} from './valkhana-session-service'

const profile = {
  id: 'test2',
  name: 'test2',
  path: '/home/hermes-v1-test/.hermes/profiles/test2',
}

function session(id: string, title: string): ValkhanaSession {
  return {
    id,
    title,
    source: 'cli',
    model: 'openai/gpt-5.6-terra',
    startedAt: 100,
    endedAt: null,
    lastActive: 200,
    active: true,
    messageCount: 4,
    toolCallCount: 1,
    inputTokens: 120,
    outputTokens: 30,
  }
}

function fakeStore(initial: unknown = null) {
  let current = initial
  const store: ValkhanaProfileStore = {
    profile,
    readJson: vi.fn(async () => current),
    writeJson: vi.fn(async (_file, value) => {
      current = value
    }),
  }
  return { store, read: () => current }
}

describe('profile-scoped session organizer service', () => {
  it('joins active-profile metadata to normalized dashboard sessions and filters it', async () => {
    const { store } = fakeStore({
      version: 1,
      profileId: 'test2',
      updatedAt: '2026-07-30T12:00:00.000Z',
      sessions: {
        one: {
          pinned: true,
          archived: false,
          project: 'Valkhana',
          tags: ['security'],
          updatedAt: '2026-07-30T12:00:00.000Z',
        },
      },
    })

    const result = await readActiveOrganizedSessions(
      { project: 'valkhana', pinned: true },
      {
        resolveStore: async () => store,
        fetchSessions: async () => ({
          sessions: [session('one', 'One'), session('two', 'Two')],
          total: 2,
          limit: 100,
          offset: 0,
        }),
      },
    )

    expect(result.profile).toEqual({ id: 'test2', name: 'test2' })
    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0]).toMatchObject({
      id: 'one',
      title: 'One',
      metadata: { pinned: true, project: 'Valkhana', tags: ['security'] },
    })
  })

  it('serializes concurrent updates so one profile does not lose metadata', async () => {
    const { store, read } = fakeStore()
    const fetchDetail = vi.fn(async (id: string) => session(id, id))

    await Promise.all([
      mutateActiveSessionOrganizer(
        { sessionId: 'one', pinned: true },
        {
          resolveStore: async () => store,
          fetchDetail,
          now: () => new Date('2026-07-30T12:01:00.000Z'),
        },
      ),
      mutateActiveSessionOrganizer(
        { sessionId: 'two', project: 'Valkhana' },
        {
          resolveStore: async () => store,
          fetchDetail,
          now: () => new Date('2026-07-30T12:02:00.000Z'),
        },
      ),
    ])

    expect(read()).toMatchObject({
      profileId: 'test2',
      sessions: {
        one: { pinned: true },
        two: { project: 'Valkhana' },
      },
    })
  })

  it('checks the stable id against the active dashboard profile before writing', async () => {
    const { store } = fakeStore()
    const fetchDetail = vi.fn(async () => {
      throw new Error('dashboard session not found')
    })

    await expect(
      mutateActiveSessionOrganizer(
        { sessionId: 'missing', archived: true },
        { resolveStore: async () => store, fetchDetail },
      ),
    ).rejects.toThrow('dashboard session not found')
    expect(store.writeJson).not.toHaveBeenCalled()
  })

  it('exports a whitelisted projection as JSON and Markdown', async () => {
    const { store } = fakeStore()
    const dependencies = {
      resolveStore: async () => store,
      fetchSessions: async () => ({
        sessions: [session('one', 'Architecture review')],
        total: 1,
        limit: 100,
        offset: 0,
      }),
      now: () => new Date('2026-07-30T12:03:00.000Z'),
    }

    const json = await exportActiveOrganizedSessions('json', {}, dependencies)
    const markdown = await exportActiveOrganizedSessions(
      'markdown',
      {},
      dependencies,
    )

    expect(JSON.parse(json.body)).toEqual({
      version: 1,
      exportedAt: '2026-07-30T12:03:00.000Z',
      profile: { id: 'test2', name: 'test2' },
      sessions: [
        expect.objectContaining({
          id: 'one',
          title: 'Architecture review',
          metadata: expect.objectContaining({ pinned: false, tags: [] }),
        }),
      ],
    })
    expect(json.body).not.toContain('messages')
    expect(json.body).not.toContain('preview')
    expect(markdown.body).toContain('# Valkhana Sessions — test2')
    expect(markdown.body).toContain('## Architecture review')
  })
})
