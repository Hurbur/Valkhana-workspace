import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
})

async function loadBackend(options?: {
  cards?: Array<Record<string, unknown>>
  updatedCard?: Record<string, unknown> | null
}) {
  const listKanbanCards = vi.fn(async () => options?.cards ?? [])
  const createKanbanCard = vi.fn(async (input) => ({
    id: 'card-created',
    title: input.title,
    spec: input.spec ?? '',
    acceptanceCriteria: [],
    assignedWorker: input.assignedWorker ?? null,
    reviewer: null,
    status: input.status ?? 'backlog',
    missionId: null,
    reportPath: null,
    createdBy: input.createdBy ?? 'user',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  }))
  const updateKanbanCard = vi.fn(async (_taskId, _updates) => options?.updatedCard ?? null)
  const getKanbanBackendMeta = vi.fn(() => ({
    id: 'hermes-proxy',
    label: 'Hermes Dashboard kanban',
    detected: true,
    writable: true,
  }))

  vi.doMock('./kanban-backend', () => ({
    KanbanAdapterError: class KanbanAdapterError extends Error {
      constructor(message: string, public status = 409) { super(message) }
    },
    listKanbanCards,
    createKanbanCard,
    updateKanbanCard,
    getKanbanBackendMeta,
  }))

  const mod = await import('./claude-tasks-backend')
  return { mod, listKanbanCards, createKanbanCard, updateKanbanCard, getKanbanBackendMeta }
}

describe('claude-tasks-backend', () => {
  it('maps shared kanban cards into /tasks records and preserves blocked cards', async () => {
    const { mod } = await loadBackend({
      cards: [
        {
          id: 'card-1',
          title: 'Blocked card',
          spec: 'Investigate runtime edge case',
          acceptanceCriteria: [],
          assignedWorker: 'swarm6',
          reviewer: null,
          status: 'blocked',
          missionId: null,
          reportPath: null,
          createdBy: 'aurora',
          createdAt: 1_700_000_000_000,
          updatedAt: 1_700_000_050_000,
        },
      ],
    })

    const tasks = await mod.listClaudeTasks({ includeDone: true })
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({
      id: 'card-1',
      title: 'Blocked card',
      description: 'Investigate runtime edge case',
      column: 'blocked',
      assignee: 'swarm6',
      created_by: 'aurora',
    })
  })

  it('creates safe triage tasks through the Core-backed adapter', async () => {
    const { mod, createKanbanCard } = await loadBackend()

    const task = await mod.createClaudeTask({
      title: 'Wire workspace board to shared kanban',
      description: 'Proxy through Agent API',
      column: 'backlog',
      created_by: 'user',
      idempotency_key: 'claude-task-1',
    })

    expect(createKanbanCard).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Wire workspace board to shared kanban',
      spec: 'Proxy through Agent API',
      assignedWorker: null,
      status: 'backlog',
      createdBy: 'user',
      idempotencyKey: 'claude-task-1',
    }))
    expect(task).toMatchObject({ id: 'card-created', column: 'backlog', assignee: null })
  })

  it('rejects legacy assignment and promotion instead of silently dropping them', async () => {
    const { mod, createKanbanCard } = await loadBackend()
    await expect(mod.createClaudeTask({
      title: 'Unsafe task',
      column: 'todo',
      assignee: 'swarm3',
      idempotency_key: 'unsafe-1',
    })).rejects.toThrow('Only unassigned medium-priority backlog admission')
    expect(createKanbanCard).not.toHaveBeenCalled()
  })

  it('moves running and blocked cards through kanban status updates', async () => {
    const { mod, updateKanbanCard } = await loadBackend({
      updatedCard: {
        id: 'card-2',
        title: 'Updated card',
        spec: 'Now blocked',
        acceptanceCriteria: [],
        assignedWorker: 'swarm5',
        reviewer: null,
        status: 'blocked',
        missionId: null,
        reportPath: null,
        createdBy: 'aurora',
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_090_000,
      },
    })

    const task = await mod.moveClaudeTask('card-2', 'blocked')
    expect(updateKanbanCard).toHaveBeenCalledWith('card-2', expect.objectContaining({ status: 'blocked' }))
    expect(task).toMatchObject({ id: 'card-2', column: 'blocked' })
  })
})
