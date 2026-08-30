import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import { SWARM_ROSTER_PATH, readSwarmRoster } from '../../server/swarm-roster'
import { listSwarmWorkerIds } from '../../server/swarm-foundation'

export const Route = createFileRoute('/api/swarm-roster')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        const ids = listSwarmWorkerIds()
        return json({
          ok: true,
          path: SWARM_ROSTER_PATH,
          roster: readSwarmRoster(ids),
          fetchedAt: Date.now(),
        })
      },
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        try {
          await request.json()
        } catch {
          return json({ ok: false, error: 'Invalid JSON body' }, { status: 400 })
        }
        return json(
          {
            ok: false,
            error:
              'Runtime roster mutation is disabled; worker registry changes must use the reviewed ValKhana configuration path',
          },
          { status: 409 },
        )
      },
    },
  },
})
