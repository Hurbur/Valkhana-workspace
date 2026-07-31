import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import { ValkhanaAdapterError } from '../../../server/valkhana-dashboard-adapter'
import { ValkhanaProfileStoreError } from '../../../server/valkhana-profile-store'
import { exportActiveOrganizedSessions } from '../../../server/valkhana-session-service'

function parseFilters(url: URL) {
  const filters: {
    sessionId?: string
    project?: string
    tag?: string
    archived?: boolean
    pinned?: boolean
  } = {}
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
 * Authenticated, on-demand Markdown/JSON export of the active profile's
 * organized sessions. Distinct from the snapshot route: this always reflects
 * live data and requires a Workspace session; it produces no persisted,
 * shareable artifact.
 */
export const Route = createFileRoute('/api/dashboard/sessions/export')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        const url = new URL(request.url)
        const format =
          url.searchParams.get('format') === 'markdown' ? 'markdown' : 'json'
        try {
          const exported = await exportActiveOrganizedSessions(
            format,
            parseFilters(url),
          )
          return new Response(exported.body, {
            headers: {
              'Content-Type': exported.contentType,
              'Content-Disposition': `attachment; filename="${exported.filename}"`,
            },
          })
        } catch (error) {
          const message =
            error instanceof Error ? error.message : 'export failed'
          const status =
            error instanceof ValkhanaProfileStoreError ||
            error instanceof SyntaxError
              ? 400
              : error instanceof ValkhanaAdapterError
                ? error.status
                : 500
          return json({ error: message }, { status })
        }
      },
    },
  },
})
