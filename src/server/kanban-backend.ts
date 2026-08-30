import type {
  CreateSwarmKanbanCardInput,
  SwarmKanbanCard,
  UpdateSwarmKanbanCardInput,
} from './swarm-kanban-store'
import {
  taskMutationForColumn,
  type HermesTask,
  type HermesTaskResponse,
  type HermesTasksResponse,
} from './hermes-task-projection'
import { requestValkhanaCore, ValkhanaCoreError } from './valkhana-core-client'

export type KanbanBackendId = 'valkhana-core'

export type KanbanBackendMeta = {
  id: KanbanBackendId
  label: string
  detected: boolean
  writable: boolean
  details?: string | null
  path?: string | null
}

export class KanbanAdapterError extends Error {
  constructor(message: string, public readonly status = 409) {
    super(message)
    this.name = 'KanbanAdapterError'
  }
}

function status(task: HermesTask): SwarmKanbanCard['status'] {
  switch (task.status) {
    case 'triage': return 'backlog'
    case 'todo': return 'todo'
    case 'scheduled':
    case 'ready': return 'ready'
    case 'running': return 'running'
    case 'review': return 'review'
    case 'blocked': return 'blocked'
    case 'done': return 'done'
    case 'archived': return 'done'
  }
}

function project(task: HermesTask): SwarmKanbanCard {
  const updated = task.completed_at ?? task.started_at ?? task.created_at
  return {
    id: task.id,
    title: task.title,
    spec: task.body ?? '',
    acceptanceCriteria: [],
    assignedWorker: task.assignee,
    reviewer: null,
    status: status(task),
    missionId: null,
    reportPath: null,
    createdBy: task.created_by,
    createdAt: task.created_at * 1000,
    updatedAt: updated * 1000,
    parents: [],
    children: [],
    latestRun: task.result ? { summary: task.result } : null,
    tags: task.skills,
    source: 'valkhana-core-hermes',
  }
}

function nonEmpty(values: Array<string> | undefined): boolean {
  return Boolean(values?.some((value) => value.trim()))
}

function assertSafeAdmission(input: CreateSwarmKanbanCardInput): string {
  const idempotencyKey = input.idempotencyKey?.trim()
  if (!idempotencyKey) {
    throw new KanbanAdapterError('idempotencyKey is required for Hermes task admission', 400)
  }
  if (idempotencyKey.length > 128 || !/^[A-Za-z0-9._-]+$/.test(idempotencyKey)) {
    throw new KanbanAdapterError('idempotencyKey must be a 1-128 character identifier', 400)
  }
  if (
    (input.status !== undefined && input.status !== null && input.status !== 'backlog') ||
    input.assignedWorker != null ||
    input.reviewer != null ||
    input.missionId != null ||
    input.reportPath != null ||
    nonEmpty(input.acceptanceCriteria) ||
    nonEmpty(input.parents) ||
    nonEmpty(input.tags)
  ) {
    throw new KanbanAdapterError(
      'Only unassigned triage admission is supported; assignment, lane selection, review, mission, criteria, dependency, report, and tag fields remain Hermes-owned',
    )
  }
  return idempotencyKey
}

function requestedFields(updates: UpdateSwarmKanbanCardInput): Array<string> {
  return Object.entries(updates)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key)
}

export function getKanbanBackendMeta(): KanbanBackendMeta {
  return {
    id: 'valkhana-core',
    label: 'ValKhana Core / Hermes',
    detected: true,
    writable: true,
    path: null,
    details: 'Hermes is the sole task authority; supported lifecycle operations pass through ValKhana Core.',
  }
}

export async function listKanbanCards(): Promise<SwarmKanbanCard[]> {
  const response = await requestValkhanaCore<HermesTasksResponse>('/v1/integrations/hermes/tasks')
  return response.tasks
    .filter((task) => task.status !== 'archived')
    .map(project)
    .sort((a, b) => b.updatedAt - a.updatedAt || a.title.localeCompare(b.title))
}

export async function createKanbanCard(input: CreateSwarmKanbanCardInput): Promise<SwarmKanbanCard> {
  const idempotencyKey = assertSafeAdmission(input)
  const response = await requestValkhanaCore<HermesTaskResponse>('/v1/integrations/hermes/tasks', {
    method: 'POST',
    body: {
      title: input.title.trim(),
      description: input.spec?.trim() || undefined,
      idempotency_key: idempotencyKey,
    },
  })
  return project(response.task)
}

export async function updateKanbanCard(
  cardId: string,
  updates: UpdateSwarmKanbanCardInput,
): Promise<SwarmKanbanCard | null> {
  const fields = requestedFields(updates)
  if (fields.length === 0) {
    try {
      return project((await requestValkhanaCore<HermesTaskResponse>(`/v1/integrations/hermes/tasks/${cardId}`)).task)
    } catch (error) {
      if (error instanceof ValkhanaCoreError && error.status === 404) return null
      throw error
    }
  }
  if (fields.length !== 1 || fields[0] !== 'status' || !updates.status) {
    throw new KanbanAdapterError(
      'Legacy card field edits are frozen; only supported Hermes lifecycle lane transitions are accepted',
    )
  }
  const column = updates.status === 'running' ? 'in_progress' : updates.status
  const mutation = taskMutationForColumn(column)
  if (!mutation) {
    throw new KanbanAdapterError(
      'This lane transition is owned by Hermes admission/dispatcher and is not available as a manual board move',
    )
  }
  try {
    const response = await requestValkhanaCore<HermesTaskResponse>(
      `/v1/integrations/hermes/tasks/${cardId}`,
      mutation,
    )
    return project(response.task)
  } catch (error) {
    if (error instanceof ValkhanaCoreError && error.status === 404) return null
    throw error
  }
}
