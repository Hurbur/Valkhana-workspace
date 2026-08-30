import type { TaskColumn, TaskPriority, TaskRecord } from './tasks-store'

export type HermesTaskStatus =
  | 'triage'
  | 'todo'
  | 'scheduled'
  | 'ready'
  | 'running'
  | 'blocked'
  | 'review'
  | 'done'
  | 'archived'

export type HermesTask = {
  id: string
  title: string
  body: string | null
  assignee: string | null
  status: HermesTaskStatus
  priority: number
  created_by: string
  created_at: number
  started_at: number | null
  completed_at: number | null
  result: string | null
  skills: Array<string>
  session_id: string | null
}

export type HermesTaskResponse = { task: HermesTask }
export type HermesTasksResponse = { board: string; tasks: Array<HermesTask> }

function column(status: HermesTaskStatus): TaskColumn {
  switch (status) {
    case 'triage': return 'backlog'
    case 'todo':
    case 'scheduled':
    case 'ready': return 'todo'
    case 'running': return 'in_progress'
    case 'blocked': return 'blocked'
    case 'review': return 'review'
    case 'done': return 'done'
    case 'archived': return 'deleted'
  }
}

function priority(value: number): TaskPriority {
  if (value > 0) return 'high'
  if (value < 0) return 'low'
  return 'medium'
}

function iso(seconds: number): string {
  return new Date(seconds * 1000).toISOString()
}

export function projectHermesTask(task: HermesTask): TaskRecord {
  const latest = task.completed_at ?? task.started_at ?? task.created_at
  return {
    id: task.id,
    title: task.title,
    description: task.body ?? '',
    column: column(task.status),
    priority: priority(task.priority),
    assignee: task.assignee,
    tags: task.skills,
    due_date: null,
    position: -task.priority,
    created_by: task.created_by,
    created_at: iso(task.created_at),
    updated_at: iso(latest),
    session_id: task.session_id,
  }
}

export function taskMutationForColumn(
  column: TaskColumn,
): { method: 'PATCH' | 'DELETE'; body?: unknown } | null {
  switch (column) {
    case 'blocked':
      return { method: 'PATCH', body: { action: 'block', reason: 'Moved to Blocked in ValKhana' } }
    case 'review':
      return { method: 'PATCH', body: { action: 'request_review', summary: 'Submitted for review in ValKhana' } }
    case 'done':
      return { method: 'PATCH', body: { action: 'complete', result: 'Completed in ValKhana' } }
    case 'deleted':
      return { method: 'DELETE' }
    case 'backlog':
    case 'todo':
    case 'in_progress':
      return null
  }
}
