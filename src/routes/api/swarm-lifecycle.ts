import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import {
  getSwarmLifecycleStatus,
} from '../../server/swarm-lifecycle'
import { listSwarmWorkerIds } from '../../server/swarm-foundation'
import { isSwarmWorkerId } from '../../server/swarm-roster'

type LifecyclePost = {
  action?: unknown
  workerId?: unknown
}

function validWorkerId(value: unknown): string | null {
  return isSwarmWorkerId(value) ? value.trim() : null
}

export const Route = createFileRoute('/api/swarm-lifecycle')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        const url = new URL(request.url)
        const rawWorkerId = url.searchParams.get('workerId')
        const requested = validWorkerId(rawWorkerId)
        if (rawWorkerId !== null && !requested) {
          return json({ ok: false, error: 'Invalid workerId' }, { status: 400 })
        }
        const ids = requested ? [requested] : listSwarmWorkerIds()
        return json({ ok: true, checkedAt: Date.now(), workers: ids.map((id) => getSwarmLifecycleStatus(id)) })
      },
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        let body: LifecyclePost
        try { body = await request.json() as LifecyclePost } catch { return json({ ok: false, error: 'Invalid JSON body' }, { status: 400 }) }
        const action = typeof body.action === 'string' ? body.action : ''
        return json(
          {
            ok: false,
            action,
            error:
              'Worker handoff, renewal, restart, and automatic lifecycle sweeps are owned by Hermes and are unavailable through the legacy Swarm lifecycle endpoint',
          },
          { status: 409 },
        )
      },
    },
  },
})
