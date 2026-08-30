import { describe, expect, it } from 'vitest'
import { projectHermesTask, taskMutationForColumn, type HermesTask } from './hermes-task-projection'

const task: HermesTask = {
  id: 't_123',
  title: 'Build',
  body: 'Details',
  assignee: null,
  status: 'ready',
  priority: 2,
  created_by: 'valkhana',
  created_at: 1,
  started_at: null,
  completed_at: null,
  result: null,
  skills: ['rust'],
  session_id: null,
}

describe('Hermes task compatibility projection', () => {
  it('maps Hermes identity and lifecycle without inventing mutable state', () => {
    expect(projectHermesTask(task)).toMatchObject({
      id: 't_123',
      column: 'todo',
      priority: 'high',
      tags: ['rust'],
      position: -2,
      created_at: '1970-01-01T00:00:01.000Z',
    })
    expect(projectHermesTask({ ...task, status: 'triage' }).column).toBe('backlog')
    expect(projectHermesTask({ ...task, status: 'running' }).column).toBe('in_progress')
    expect(projectHermesTask({ ...task, status: 'archived' }).column).toBe('deleted')
  })

  it('maps only supported lifecycle transitions', () => {
    expect(taskMutationForColumn('blocked')).toMatchObject({ method: 'PATCH' })
    expect(taskMutationForColumn('review')).toMatchObject({ method: 'PATCH' })
    expect(taskMutationForColumn('done')).toMatchObject({ method: 'PATCH' })
    expect(taskMutationForColumn('deleted')).toEqual({ method: 'DELETE' })
    expect(taskMutationForColumn('in_progress')).toBeNull()
  })
})
