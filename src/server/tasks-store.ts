import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type TaskColumn = 'backlog' | 'todo' | 'in_progress' | 'review' | 'blocked' | 'done' | 'deleted'
export type TaskPriority = 'high' | 'medium' | 'low'

export type TaskRecord = {
  id: string
  title: string
  description: string
  column: TaskColumn
  priority: TaskPriority
  assignee: string | null
  tags: string[]
  due_date: string | null
  position: number
  created_by: string
  created_at: string
  updated_at: string
  session_id?: string | null
}

type TaskFile = { tasks: TaskRecord[] }

type TaskFilters = {
  column?: string | null
  assignee?: string | null
  priority?: string | null
  includeDone?: boolean
}

const CLAUDE_HOME = process.env.HERMES_HOME ?? process.env.CLAUDE_HOME ?? path.join(os.homedir(), '.hermes')
const TASKS_FILE = path.join(CLAUDE_HOME, 'tasks.json')

function readTaskFile(): TaskFile {
  if (!fs.existsSync(TASKS_FILE)) return { tasks: [] }
  try {
    const raw = fs.readFileSync(TASKS_FILE, 'utf-8').trim()
    if (!raw) return { tasks: [] }
    const parsed = JSON.parse(raw) as Partial<TaskFile>
    return { tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [] }
  } catch (err) {
    // This is a read-only legacy migration input. Never repair or replace it
    // in place; log corruption and leave recovery to an explicit importer.
    console.error(`[tasks-store] Failed to read legacy ${TASKS_FILE}:`, err)
    return { tasks: [] }
  }
}

function normalizeTask(task: Partial<TaskRecord> & Pick<TaskRecord, 'id' | 'title' | 'created_at' | 'updated_at' | 'created_by'>): TaskRecord {
  return {
    id: task.id,
    title: task.title,
    description: task.description ?? '',
    column: (task.column as TaskColumn) ?? 'backlog',
    priority: (task.priority as TaskPriority) ?? 'medium',
    assignee: task.assignee ?? null,
    tags: Array.isArray(task.tags) ? task.tags.filter((tag): tag is string => typeof tag === 'string') : [],
    due_date: task.due_date ?? null,
    position: typeof task.position === 'number' ? task.position : 0,
    created_by: task.created_by,
    created_at: task.created_at,
    updated_at: task.updated_at,
    session_id: task.session_id ?? null,
  }
}

export function listTasks(filters: TaskFilters = {}): TaskRecord[] {
  let tasks = readTaskFile().tasks.map(normalizeTask)
  if (!filters.includeDone) {
    tasks = tasks.filter((task) => task.column !== 'done')
  }
  if (filters.column) {
    tasks = tasks.filter((task) => task.column === filters.column)
  }
  if (filters.assignee) {
    tasks = tasks.filter((task) => task.assignee === filters.assignee)
  }
  if (filters.priority) {
    tasks = tasks.filter((task) => task.priority === filters.priority)
  }
  return tasks.sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at))
}

export function getTask(taskId: string): TaskRecord | null {
  return readTaskFile().tasks.map(normalizeTask).find((task) => task.id === taskId) ?? null
}
