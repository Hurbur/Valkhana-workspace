import { beforeEach, describe, expect, it, vi } from 'vitest'

const coreMock = vi.hoisted(() => vi.fn())

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: (_path: string) => (options: unknown) => options,
}))
vi.mock('../../server/auth-middleware', () => ({ isAuthenticated: () => true }))
vi.mock('../../server/valkhana-core-client', () => ({
  requestValkhanaCore: coreMock,
  ValkhanaCoreError: class ValkhanaCoreError extends Error {
    constructor(message: string, public status: number) {
      super(message)
    }
  },
}))

const hermesTask = {
  id: 't_123',
  title: 'Build',
  body: 'Details',
  assignee: null,
  status: 'triage',
  priority: 0,
  created_by: 'valkhana',
  created_at: 1,
  started_at: null,
  completed_at: null,
  result: null,
  skills: [],
  session_id: null,
}

async function handlers(modulePath: string) {
  const module = await import(modulePath)
  return (module as any).Route.server.handlers
}

beforeEach(() => coreMock.mockReset())

describe('Hermes-backed task compatibility routes', () => {
  it('lists and creates through core without probing a local fallback', async () => {
    coreMock
      .mockResolvedValueOnce({ board: 'valkhana', tasks: [hermesTask] })
      .mockResolvedValueOnce({ task: hermesTask })
    const route = await handlers('./hermes-tasks')

    const listed = await route.GET({
      request: new Request('http://localhost/api/hermes-tasks'),
    })
    expect(await listed.json()).toMatchObject({
      board: 'valkhana',
      tasks: [{ id: 't_123', column: 'backlog' }],
    })

    const created = await route.POST({
      request: new Request('http://localhost/api/hermes-tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Build',
          priority: 'medium',
          column: 'backlog',
          idempotency_key: 'request-1',
        }),
      }),
    })
    expect(created.status).toBe(201)
    expect(coreMock).toHaveBeenLastCalledWith('/v1/integrations/hermes/tasks', {
      method: 'POST',
      body: { title: 'Build', description: undefined, idempotency_key: 'request-1' },
    })
  })

  it('rejects fields that Hermes cannot preserve instead of writing legacy JSON', async () => {
    const route = await handlers('./hermes-tasks')
    const response = await route.POST({
      request: new Request('http://localhost/api/hermes-tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Assigned task',
          assignee: 'coding',
          idempotency_key: 'request-2',
        }),
      }),
    })
    expect(response.status).toBe(409)
    expect(coreMock).not.toHaveBeenCalled()
  })

  it('maps supported lifecycle moves and rejects dispatcher-owned launch/promotion', async () => {
    coreMock.mockResolvedValueOnce({ task: { ...hermesTask, status: 'blocked' } })
    const route = await handlers('./hermes-tasks.$taskId')

    const blocked = await route.POST({
      request: new Request('http://localhost/api/hermes-tasks/t_123?action=move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ column: 'blocked' }),
      }),
      params: { taskId: 't_123' },
    })
    expect(blocked.status).toBe(200)
    expect(coreMock).toHaveBeenCalledWith('/v1/integrations/hermes/tasks/t_123', {
      method: 'PATCH',
      body: { action: 'block', reason: 'Moved to Blocked in ValKhana' },
    })

    const promotion = await route.POST({
      request: new Request('http://localhost/api/hermes-tasks/t_123?action=move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ column: 'in_progress' }),
      }),
      params: { taskId: 't_123' },
    })
    expect(promotion.status).toBe(409)

    const launch = await route.POST({
      request: new Request('http://localhost/api/hermes-tasks/t_123?action=launch', {
        method: 'POST',
      }),
      params: { taskId: 't_123' },
    })
    expect(launch.status).toBe(409)
    expect(coreMock).toHaveBeenCalledTimes(1)
  })
})
