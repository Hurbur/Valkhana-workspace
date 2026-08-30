import { createFileRoute } from '@tanstack/react-router'
import { isAuthenticated } from '../../server/auth-middleware'
import { createClaudeTask, listClaudeTasks } from '../../server/claude-tasks-backend'
import type { TaskColumn, TaskPriority } from '../../server/claude-tasks-backend'
import { KanbanAdapterError } from '../../server/kanban-backend'
import { ValkhanaCoreError } from '../../server/valkhana-core-client'

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
    value === 'done'
  )
}

function isTaskPriority(value: unknown): value is TaskPriority {
  return value === 'high' || value === 'medium' || value === 'low'
}

function adapterError(error: unknown) {
  if (error instanceof KanbanAdapterError || error instanceof ValkhanaCoreError) {
    return jsonResponse({ error: error.message }, error.status)
  }
  return jsonResponse({ error: 'ValKhana Core task adapter failed' }, 502)
}

export const Route = createFileRoute('/api/claude-tasks')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return jsonResponse({ error: 'Unauthorized' }, 401)
        }

        try {
          const url = new URL(request.url)
          const tasks = await listClaudeTasks({
            column: url.searchParams.get('column'),
            assignee: url.searchParams.get('assignee'),
            priority: url.searchParams.get('priority'),
            includeDone: url.searchParams.get('include_done') === 'true',
          })
          return jsonResponse({ tasks })
        } catch (error) {
          return adapterError(error)
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

          const task = await createClaudeTask({
            title: body.title,
            description: typeof body.description === 'string' ? body.description : '',
            column: isTaskColumn(body.column) ? body.column : undefined,
            priority: isTaskPriority(body.priority) ? body.priority : undefined,
            assignee: typeof body.assignee === 'string' ? body.assignee : null,
            tags: Array.isArray(body.tags) ? body.tags.filter((tag): tag is string => typeof tag === 'string') : [],
            due_date: typeof body.due_date === 'string' ? body.due_date : null,
            created_by: typeof body.created_by === 'string' ? body.created_by : 'user',
            idempotency_key: typeof body.idempotency_key === 'string' ? body.idempotency_key : undefined,
          })

          return jsonResponse({ task }, 201)
        } catch (error) {
          if (error instanceof SyntaxError) return jsonResponse({ error: 'Invalid request body' }, 400)
          return adapterError(error)
        }
      },
    },
  },
})
