import { createFileRoute } from '@tanstack/react-router'
import { isAuthenticated } from '../../server/auth-middleware'
import type { TaskColumn, TaskPriority } from '../../server/tasks-store'
import { requestValkhanaCore, ValkhanaCoreError } from '../../server/valkhana-core-client'
import {
  projectHermesTask,
  type HermesTaskResponse,
  type HermesTasksResponse,
} from '../../server/hermes-task-projection'

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function isTaskColumn(value: unknown): value is TaskColumn {
  return (
    value === 'backlog' ||
    value === 'todo' ||
    value === 'in_progress' ||
    value === 'review' ||
    value === 'blocked' ||
    value === 'done' ||
    value === 'deleted'
  )
}

function isTaskPriority(value: unknown): value is TaskPriority {
  return value === 'high' || value === 'medium' || value === 'low'
}

function coreError(error: unknown) {
  if (error instanceof ValkhanaCoreError) {
    return jsonResponse({ error: error.message }, error.status)
  }
  return jsonResponse({ error: 'ValKhana Core task adapter failed' }, 502)
}

export const Route = createFileRoute('/api/hermes-tasks')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return jsonResponse({ error: 'Unauthorized' }, 401)
        }

        const url = new URL(request.url)
        try {
          const response = await requestValkhanaCore<HermesTasksResponse>(
            '/v1/integrations/hermes/tasks',
          )
          const column = url.searchParams.get('column')
          const assignee = url.searchParams.get('assignee')
          const priority = url.searchParams.get('priority')
          const includeDone = url.searchParams.get('include_done') === 'true'
          const tasks = response.tasks
            .map(projectHermesTask)
            .filter((task) => includeDone || task.column !== 'done')
            .filter((task) => !column || task.column === column)
            .filter((task) => !assignee || task.assignee === assignee)
            .filter((task) => !priority || task.priority === priority)
            .sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at))
          return jsonResponse({ tasks, board: response.board })
        } catch (error) {
          return coreError(error)
        }
      },

      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return jsonResponse({ error: 'Unauthorized' }, 401)
        }

        try {
          const body = (await request.json()) as Record<string, unknown>
          if (!body.title || typeof body.title !== 'string') {
            return jsonResponse({ error: 'title is required' }, 400)
          }

          const column = isTaskColumn(body.column) ? body.column : 'backlog'
          const priority = isTaskPriority(body.priority) ? body.priority : 'medium'
          const tags = Array.isArray(body.tags) ? body.tags : []
          if (
            column !== 'backlog' ||
            priority !== 'medium' ||
            (body.assignee !== undefined && body.assignee !== null) ||
            tags.length > 0 ||
            (body.due_date !== undefined && body.due_date !== null)
          ) {
            return jsonResponse(
              { error: 'Only unassigned medium-priority triage admission is currently supported' },
              409,
            )
          }
          if (typeof body.idempotency_key !== 'string' || !body.idempotency_key) {
            return jsonResponse({ error: 'idempotency_key is required' }, 400)
          }
          const response = await requestValkhanaCore<HermesTaskResponse>(
            '/v1/integrations/hermes/tasks',
            {
              method: 'POST',
              body: {
                title: body.title,
                description: typeof body.description === 'string' ? body.description : undefined,
                idempotency_key: body.idempotency_key,
              },
            },
          )
          return jsonResponse({ task: projectHermesTask(response.task) }, 201)
        } catch (error) {
          if (error instanceof SyntaxError) {
            return jsonResponse({ error: 'Invalid request body' }, 400)
          }
          return coreError(error)
        }
      },
    },
  },
})
