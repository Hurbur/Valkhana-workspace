import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import { requireJsonContentType } from '../../../server/rate-limit'
import { ValkhanaAdapterError } from '../../../server/valkhana-dashboard-adapter'
import { ValkhanaProfileStoreError } from '../../../server/valkhana-profile-store'
import { ValkhanaSessionOrganizerError } from '../../../server/valkhana-session-organizer'
import {
  mutateActiveSessionOrganizer,
  readActiveOrganizedSessions,
  type SessionOrganizerFilters,
} from '../../../server/valkhana-session-service'

function errorResponse(error: unknown): Response {
  const message =
    error instanceof Error ? error.message : 'sessions unavailable'
  const status =
    error instanceof ValkhanaSessionOrganizerError ||
    error instanceof ValkhanaProfileStoreError ||
    error instanceof SyntaxError
      ? 400
      : error instanceof ValkhanaAdapterError
        ? error.status
        : 500
  return json({ error: message }, { status })
}

function parseFilters(url: URL): SessionOrganizerFilters {
  const filters: SessionOrganizerFilters = {}
  const sessionId = url.searchParams.get('sessionId')
  if (sessionId) filters.sessionId = sessionId
  const project = url.searchParams.get('project')
  const tag = url.searchParams.get('tag')
  const archived = url.searchParams.get('archived')
  const pinned = url.searchParams.get('pinned')
  if (project) filters.project = project
  if (tag) filters.tag = tag
  if (archived === 'true' || archived === 'false') {
    filters.archived = archived === 'true'
  }
  if (pinned === 'true' || pinned === 'false') {
    filters.pinned = pinned === 'true'
  }
  return filters
}

/**
 * Profile-scoped session organizer: joins live Hermes dashboard session rows
 * with locally-owned pin/archive/project/tag metadata. See
 * `valkhana-session-service.ts` for the join/mutation logic and
 * `valkhana-session-organizer.ts` for the metadata schema.
 */
export const Route = createFileRoute('/api/dashboard/sessions')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        try {
          const url = new URL(request.url)
          const result = await readActiveOrganizedSessions(parseFilters(url))
          return json(result, {
            headers: {
              'Cache-Control': 'private, max-age=10, stale-while-revalidate=30',
            },
          })
        } catch (error) {
          return errorResponse(error)
        }
      },
      PATCH: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        const contentTypeError = requireJsonContentType(request)
        if (contentTypeError) return contentTypeError
        try {
          const metadata = await mutateActiveSessionOrganizer(
            await request.json(),
          )
          return json({ metadata })
        } catch (error) {
          return errorResponse(error)
        }
      },
    },
  },
})
