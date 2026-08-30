import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import {
  getWorldModelStatus,
  startWorldModel,
  stopWorldModel,
} from '../../server/world-model'

export const Route = createFileRoute('/api/world-model')({
  server: {
    handlers: {
      GET: ({ request }) => {
        if (!isAuthenticated(request))
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        return json({
          ok: true,
          capability: 'world_model.simulate',
          auxiliary: true,
          status: getWorldModelStatus(),
        })
      },
      POST: async ({ request }) => {
        if (!isAuthenticated(request))
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        const body = (await request.json().catch(() => null)) as {
          action?: unknown
        } | null
        const action = typeof body?.action === 'string' ? body.action : ''
        try {
          if (action === 'start')
            return json({ ok: true, status: await startWorldModel() })
          if (action === 'switch')
            return json({
              ok: true,
              status: await startWorldModel({ switchExisting: true }),
            })
          if (action === 'stop')
            return json({ ok: true, status: await stopWorldModel() })
          if (action === 'status' || !action)
            return json({ ok: true, status: getWorldModelStatus() })
          return json(
            {
              ok: false,
              error: 'action must be start, switch, stop, or status',
            },
            { status: 400 },
          )
        } catch (error) {
          return json(
            {
              ok: false,
              error:
                error instanceof Error
                  ? error.message
                  : 'World model lifecycle operation failed',
            },
            { status: 409 },
          )
        }
      },
    },
  },
})
