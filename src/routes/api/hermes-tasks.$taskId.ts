import { createFileRoute } from '@tanstack/react-router'
import { isAuthenticated } from '../../server/auth-middleware'
import type { TaskColumn } from '../../server/tasks-store'
import { requestValkhanaCore, ValkhanaCoreError } from '../../server/valkhana-core-client'
import {
  projectHermesTask,
  taskMutationForColumn,
  type HermesTaskResponse,
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

function corePath(taskId: string): string {
  return `/v1/integrations/hermes/tasks/${taskId}`
}

function coreError(error: unknown) {
  if (error instanceof ValkhanaCoreError) {
    return jsonResponse({ error: error.message }, error.status)
  }
  return jsonResponse({ error: 'ValKhana Core task adapter failed' }, 502)
}

async function readTask(taskId: string): Promise<Response> {
  try {
    const response = await requestValkhanaCore<HermesTaskResponse>(corePath(taskId))
    return jsonResponse({ task: projectHermesTask(response.task) })
  } catch (error) {
    return coreError(error)
  }
}

async function moveTask(taskId: string, column: TaskColumn): Promise<Response> {
  const mutation = taskMutationForColumn(column)
  if (!mutation) {
    return jsonResponse(
      {
        error:
          'This transition is owned by Hermes admission/dispatcher and is not available as a manual board move',
      },
      409,
    )
  }
  try {
    const response = await requestValkhanaCore<HermesTaskResponse>(corePath(taskId), mutation)
    return jsonResponse({ task: projectHermesTask(response.task) })
  } catch (error) {
    return coreError(error)
  }
}

export const Route = createFileRoute('/api/hermes-tasks/$taskId')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        if (!isAuthenticated(request)) return jsonResponse({ error: 'Unauthorized' }, 401)
        return readTask(params.taskId)
      },

      PATCH: async ({ request, params }) => {
        if (!isAuthenticated(request)) return jsonResponse({ error: 'Unauthorized' }, 401)
        try {
          const body = (await request.json()) as Record<string, unknown>
          if (!isTaskColumn(body.column)) {
            return jsonResponse(
              {
                error:
                  'Legacy task field edits are frozen; only supported Hermes lifecycle column transitions are accepted',
              },
              409,
            )
          }
          return moveTask(params.taskId, body.column)
        } catch {
          return jsonResponse({ error: 'Invalid request body' }, 400)
        }
      },

      DELETE: async ({ request, params }) => {
        if (!isAuthenticated(request)) return jsonResponse({ error: 'Unauthorized' }, 401)
        try {
          await requestValkhanaCore<HermesTaskResponse>(corePath(params.taskId), {
            method: 'DELETE',
          })
          return jsonResponse({ ok: true })
        } catch (error) {
          return coreError(error)
        }
      },

      POST: async ({ request, params }) => {
        if (!isAuthenticated(request)) return jsonResponse({ error: 'Unauthorized' }, 401)
        const action = new URL(request.url).searchParams.get('action') || 'move'
        if (action === 'launch') {
          return jsonResponse(
            { error: 'Worker launch is owned by the Hermes dispatcher and cannot use a local session path' },
            409,
          )
        }
        if (action !== 'move') return jsonResponse({ error: `Unsupported action: ${action}` }, 400)
        try {
          const body = (await request.json()) as Record<string, unknown>
          if (!isTaskColumn(body.column)) {
            return jsonResponse({ error: 'column is required' }, 400)
          }
          return moveTask(params.taskId, body.column)
        } catch {
          return jsonResponse({ error: 'Invalid request body' }, 400)
        }
      },
    },
  },
})
