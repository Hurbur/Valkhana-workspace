import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: (_path: string) => (options: unknown) => options,
}))
vi.mock('../../server/auth-middleware', () => ({ isAuthenticated: () => true }))
vi.mock('../../server/kanban-backend', () => ({
  listKanbanCards: mocks.list,
  createKanbanCard: mocks.create,
  updateKanbanCard: mocks.update,
  getKanbanBackendMeta: () => ({ id: 'valkhana-core', detected: true, writable: true }),
  KanbanAdapterError: class KanbanAdapterError extends Error {
    constructor(message: string, public status = 409) { super(message) }
  },
}))
vi.mock('../../server/valkhana-core-client', () => ({
  ValkhanaCoreError: class ValkhanaCoreError extends Error {
    constructor(message: string, public status: number) { super(message) }
  },
}))

async function route() {
  const module = await import('./swarm-kanban')
  return (module as any).Route.server.handlers
}

beforeEach(() => vi.clearAllMocks())

describe('Core-backed swarm Kanban route', () => {
  it('reports the canonical Core backend when listing cards', async () => {
    mocks.list.mockResolvedValue([{ id: 't_1' }])
    const response = await (await route()).GET({ request: new Request('http://localhost/api/swarm-kanban') })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      cards: [{ id: 't_1' }],
      backend: { id: 'valkhana-core' },
    })
  })

  it('passes idempotent safe admission to the adapter', async () => {
    mocks.create.mockResolvedValue({ id: 't_2' })
    const response = await (await route()).POST({
      request: new Request('http://localhost/api/swarm-kanban', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Admit', idempotencyKey: 'request-2' }),
      }),
    })
    expect(response.status).toBe(201)
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Admit',
      status: 'backlog',
      idempotencyKey: 'request-2',
    }))
  })

  it('preserves explicit adapter conflict status', async () => {
    const { KanbanAdapterError } = await import('../../server/kanban-backend')
    mocks.update.mockRejectedValue(new KanbanAdapterError('dispatcher-owned'))
    const response = await (await route()).PATCH({
      request: new Request('http://localhost/api/swarm-kanban', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 't_2', status: 'running' }),
      }),
    })
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: 'dispatcher-owned' })
  })
})
