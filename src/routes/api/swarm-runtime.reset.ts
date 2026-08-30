import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import { requireJsonContentType } from '../../server/rate-limit'

type ResetBody = {
  workerIds?: unknown
  reason?: unknown
  actor?: unknown
}

function cleanString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export const Route = createFileRoute('/api/swarm-runtime/reset')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        const csrfCheck = requireJsonContentType(request)
        if (csrfCheck) return csrfCheck

        let body: ResetBody
        try {
          body = (await request.json()) as ResetBody
        } catch {
          return json({ ok: false, error: 'Invalid JSON body' }, { status: 400 })
        }

        return json(
          {
            ok: false,
            actor: cleanString(body.actor),
            reason: cleanString(body.reason),
            error:
              'Worker runtime reset is disabled because Hermes owns worker and task lifecycle state',
          },
          { status: 409 },
        )
      },
    },
  },
})
