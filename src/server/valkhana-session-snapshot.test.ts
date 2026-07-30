import { describe, expect, it, vi } from 'vitest'
import type { ValkhanaProfileStore } from './valkhana-profile-store'
import {
  createSessionSnapshot,
  readSessionSnapshot,
  ValkhanaSessionSnapshotError,
} from './valkhana-session-snapshot'

const profile = {
  id: 'test2',
  name: 'test2',
  path: '/home/hermes-v1-test/.hermes/profiles/test2',
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

vi.mock('./valkhana-session-service', () => ({
  exportActiveOrganizedSessions: vi.fn(async (format: string) => ({
    body:
      format === 'markdown'
        ? '# Valkhana Sessions — test2\n'
        : '{"version":1,"sessions":[]}\n',
    contentType:
      format === 'markdown'
        ? 'text/markdown; charset=utf-8'
        : 'application/json; charset=utf-8',
    filename: `valkhana-sessions-test2.${format === 'markdown' ? 'md' : 'json'}`,
  })),
}))

describe('session snapshot store', () => {
  it('creates a snapshot with a 256-bit capability id and an expiry in the future', async () => {
    const { store, read } = fakeStore()
    const now = new Date('2026-07-30T12:00:00.000Z')

    const result = await createSessionSnapshot(
      'json',
      {},
      { resolveStore: async () => store, now: () => now },
    )

    expect(result.id).toMatch(/^[A-Za-z0-9_-]{40,}$/)
    expect(new Date(result.expiresAt).getTime()).toBeGreaterThan(now.getTime())
    const persisted = read() as { snapshots: Record<string, unknown> }
    expect(Object.keys(persisted.snapshots)).toEqual([result.id])
  })

  it('reads back a live snapshot by id', async () => {
    const { store } = fakeStore()
    const now = new Date('2026-07-30T12:00:00.000Z')
    const { id } = await createSessionSnapshot(
      'markdown',
      {},
      { resolveStore: async () => store, now: () => now },
    )

    const record = await readSessionSnapshot(id, {
      resolveStore: async () => store,
      now: () => now,
    })

    expect(record).toMatchObject({
      id,
      profileId: 'test2',
      format: 'markdown',
      body: expect.stringContaining('Valkhana Sessions'),
    })
  })

  it('returns null for an expired snapshot without distinguishing it from "never existed"', async () => {
    const { store } = fakeStore()
    const createdAt = new Date('2026-07-30T12:00:00.000Z')
    const { id } = await createSessionSnapshot(
      'json',
      {},
      { resolveStore: async () => store, now: () => createdAt, ttlHours: 1 },
    )

    const afterExpiry = new Date('2026-07-30T14:00:00.000Z')
    const record = await readSessionSnapshot(id, {
      resolveStore: async () => store,
      now: () => afterExpiry,
    })

    expect(record).toBeNull()
  })

  it('returns null for a well-formed but unknown snapshot id', async () => {
    const { store } = fakeStore()
    const record = await readSessionSnapshot(
      'a'.repeat(43),
      { resolveStore: async () => store },
    )
    expect(record).toBeNull()
  })

  it('rejects a malformed snapshot id before touching the profile store', async () => {
    const { store } = fakeStore()
    await expect(
      readSessionSnapshot('../../etc/passwd', {
        resolveStore: async () => store,
      }),
    ).rejects.toThrow(ValkhanaSessionSnapshotError)
    expect(store.readJson).not.toHaveBeenCalled()
  })

  it('prunes expired snapshots on the next create so the file does not grow unbounded', async () => {
    const { store, read } = fakeStore()
    const first = await createSessionSnapshot(
      'json',
      {},
      {
        resolveStore: async () => store,
        now: () => new Date('2026-07-30T12:00:00.000Z'),
        ttlHours: 1,
      },
    )
    const second = await createSessionSnapshot(
      'json',
      {},
      {
        resolveStore: async () => store,
        now: () => new Date('2026-07-30T14:00:00.000Z'),
      },
    )

    const persisted = read() as { snapshots: Record<string, unknown> }
    expect(Object.keys(persisted.snapshots)).toEqual([second.id])
    expect(Object.keys(persisted.snapshots)).not.toContain(first.id)
  })
})
