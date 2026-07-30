/**
 * GET /api/dashboard/valkhana-briefing
 *
 * Server-side aggregation for the Valkhana daily-briefing dashboard card:
 * active profiles, session stats, and cron job status, pulled from the real
 * Hermes Agent dashboard via the dedicated `valkhana-read` plugin's bearer
 * token (see src/server/valkhana-dashboard-adapter.ts for why this is a
 * separate path from the existing gateway-capabilities fetchers).
 *
 * Gated by Valkhana's own browser-session auth (isAuthenticated) — same
 * pattern as /api/dashboard/overview. The Hermes-side bearer secret never
 * reaches the browser; only this normalized summary does.
 */
import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import { fetchValkhanaBriefing } from '../../../server/valkhana-dashboard-adapter'

export const Route = createFileRoute('/api/dashboard/valkhana-briefing')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        try {
          const { data, errors } = await fetchValkhanaBriefing()
          return json(
            { ...data, errors },
            {
              headers: {
                'Cache-Control':
                  'private, max-age=15, stale-while-revalidate=60',
              },
            },
          )
        } catch (err) {
          return json(
            {
              error:
                err instanceof Error ? err.message : 'briefing fetch failed',
            },
            { status: 500 },
          )
        }
      },
    },
  },
})
