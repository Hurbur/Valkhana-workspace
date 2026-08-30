import { afterEach, describe, expect, it, vi } from 'vitest'

const { requestValkhanaCore } = vi.hoisted(() => ({ requestValkhanaCore: vi.fn() }))

vi.mock('./valkhana-core-client', async () => {
  const actual = await vi.importActual<typeof import('./valkhana-core-client')>('./valkhana-core-client')
  return { ...actual, requestValkhanaCore }
})

import {
  createKanbanCard,
  getKanbanBackendMeta,
  KanbanAdapterError,
  listKanbanCards,
  updateKanbanCard,
} from './kanban-backend'

const task = {
  id: 't_core1',
  title: 'Core task',
  body: 'Canonical body',
  assignee: null,
  status: 'triage' as const,
  priority: 0,
  created_by: 'valkhana',
  created_at: 10,
  started_at: null,
  completed_at: null,
  result: null,
  skills: [],
  session_id: null,
}

afterEach(() => vi.clearAllMocks())

describe('kanban-backend', () => {
  it('always reports the Core/Hermes authority', () => {
    expect(getKanbanBackendMeta()).toEqual(expect.objectContaining({
      id: 'valkhana-core',
      detected: true,
      writable: true,
      path: null,
    }))
  })

  it('lists and projects canonical Hermes tasks through Core', async () => {
    requestValkhanaCore.mockResolvedValue({ board: 'valkhana', tasks: [task, { ...task, id: 't_archived', status: 'archived' }] })

    await expect(listKanbanCards()).resolves.toEqual([
      expect.objectContaining({
        id: 't_core1',
        status: 'backlog',
        source: 'valkhana-core-hermes',
        createdAt: 10_000,
      }),
    ])
    expect(requestValkhanaCore).toHaveBeenCalledWith('/v1/integrations/hermes/tasks')
  })

  it('admits only idempotent unassigned triage tasks', async () => {
    requestValkhanaCore.mockResolvedValue({ task })

    await createKanbanCard({
      title: 'Core task',
      spec: 'Canonical body',
      status: 'backlog',
      idempotencyKey: 'swarm-create-1',
    })

    expect(requestValkhanaCore).toHaveBeenCalledWith('/v1/integrations/hermes/tasks', {
      method: 'POST',
      body: {
        title: 'Core task',
        description: 'Canonical body',
        idempotency_key: 'swarm-create-1',
      },
    })
  })

  it.each([
    [{ title: 'Unsafe', idempotencyKey: 'key', assignedWorker: 'builder' }, 'Only unassigned'],
    [{ title: 'Unsafe', idempotencyKey: 'key', status: 'ready' }, 'Only unassigned'],
    [{ title: 'Unsafe' }, 'idempotencyKey is required'],
  ])('rejects unsupported admission %#', async (input, message) => {
    await expect(createKanbanCard(input as never)).rejects.toEqual(expect.objectContaining({
      name: 'KanbanAdapterError',
      message: expect.stringContaining(message),
    }))
    expect(requestValkhanaCore).not.toHaveBeenCalled()
  })

  it.each([
    ['blocked', { action: 'block', reason: 'Moved to Blocked in ValKhana' }],
    ['review', { action: 'request_review', summary: 'Submitted for review in ValKhana' }],
    ['done', { action: 'complete', result: 'Completed in ValKhana' }],
  ] as const)('passes the supported %s transition through Core', async (lane, body) => {
    requestValkhanaCore.mockResolvedValue({ task: { ...task, status: lane } })

    await updateKanbanCard('t_core1', { status: lane })

    expect(requestValkhanaCore).toHaveBeenCalledWith('/v1/integrations/hermes/tasks/t_core1', {
      method: 'PATCH',
      body,
    })
  })

  it('rejects dispatcher-owned moves and legacy field edits', async () => {
    await expect(updateKanbanCard('t_core1', { status: 'running' })).rejects.toBeInstanceOf(KanbanAdapterError)
    await expect(updateKanbanCard('t_core1', { title: 'Changed' })).rejects.toBeInstanceOf(KanbanAdapterError)
    expect(requestValkhanaCore).not.toHaveBeenCalled()
  })
})
