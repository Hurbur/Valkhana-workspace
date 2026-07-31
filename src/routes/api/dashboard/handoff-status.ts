import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import { requireJsonContentType } from '../../../server/rate-limit'
import {
  isHandoffStatusStale,
  parseHandoffStatusPatch,
  ValkhanaHandoffStatusError,
} from '../../../server/valkhana-handoff-status'
import {
  ValkhanaHandoffAuthorizationError,
  assertTerminalBrowserMutationAuthorized,
} from '../../../server/valkhana-handoff-auth'
import {
  ValkhanaProfileStoreError,
} from '../../../server/valkhana-profile-store'
import {
  mutateActiveHandoffStatus,
  readActiveHandoffStatus,
} from '../../../server/valkhana-handoff-service'

function errorResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : 'handoff status unavailable'
  const status =
    error instanceof ValkhanaHandoffStatusError ||
    error instanceof ValkhanaProfileStoreError ||
    error instanceof ValkhanaHandoffAuthorizationError ||
    error instanceof SyntaxError
      ? 400
      : 500
  const errorStatus =
    error instanceof ValkhanaHandoffAuthorizationError ? error.status : status
  return json({ error: message }, { status: errorStatus })
}

/**
 * Profile-scoped handoff coordination endpoint. It deliberately accepts only
 * state details: the active profile identity/path and actor are server-owned.
 */
export const Route = createFileRoute('/api/dashboard/handoff-status')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        try {
          const { status } = await readActiveHandoffStatus()
          return json(
            { status, stale: isHandoffStatusStale(status) },
            {
              headers: {
                'Cache-Control': 'private, max-age=15, stale-while-revalidate=45',
              },
            },
          )
        } catch (error) {
          return errorResponse(error)
        }
      },
      PATCH: async ({ request }) => {
        try {
          assertTerminalBrowserMutationAuthorized(request)
        } catch (error) {
          return errorResponse(error)
        }
        const contentTypeError = requireJsonContentType(request)
        if (contentTypeError) return contentTypeError

        try {
          const payload = parseHandoffStatusPatch(await request.json())
          const updated = await mutateActiveHandoffStatus('terminal', payload)
          return json({ status: updated, stale: false })
        } catch (error) {
          return errorResponse(error)
        }
      },
    },
  },
})
