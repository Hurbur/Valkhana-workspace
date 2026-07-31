import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import { requireJsonContentType } from '../../../server/rate-limit'
import { ValkhanaAdapterError } from '../../../server/valkhana-dashboard-adapter'
import { ValkhanaProfileStoreError } from '../../../server/valkhana-profile-store'
import {
  createSessionSnapshot,
  ValkhanaSessionSnapshotError,
} from '../../../server/valkhana-session-snapshot'
import type { SessionOrganizerFilters } from '../../../server/valkhana-session-service'

type SnapshotCreateRequest = {
  format: 'json' | 'markdown'
  filters: SessionOrganizerFilters
  ttlHours?: number
}

/**
 * Validates the raw request body before it reaches `createSessionSnapshot`.
 * A prior version cast the body to a loose inline type and passed fields
 * through unchecked — a `project` sent as a number, or a non-numeric
 * `ttlHours`, reached `.trim()`/date-math calls further down and threw an
 * unhandled 500 instead of a clean 400. Validating at this boundary is the
 * fix, per this project's own "validate at system boundaries" convention.
 */
function parseSnapshotCreateRequest(body: unknown): SnapshotCreateRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValkhanaSessionSnapshotError('request body must be an object')
  }
  const record = body as Record<string, unknown>

  const format = record.format === 'markdown' ? 'markdown' : 'json'

  const filters: SessionOrganizerFilters = {}
  if (record.project !== undefined) {
    if (typeof record.project !== 'string') {
      throw new ValkhanaSessionSnapshotError('project must be a string')
    }
    filters.project = record.project
  }
  if (record.tag !== undefined) {
    if (typeof record.tag !== 'string') {
      throw new ValkhanaSessionSnapshotError('tag must be a string')
    }
    filters.tag = record.tag
  }
  if (record.archived !== undefined) {
    if (typeof record.archived !== 'boolean') {
      throw new ValkhanaSessionSnapshotError('archived must be a boolean')
    }
    filters.archived = record.archived
  }
  if (record.pinned !== undefined) {
    if (typeof record.pinned !== 'boolean') {
      throw new ValkhanaSessionSnapshotError('pinned must be a boolean')
    }
    filters.pinned = record.pinned
  }

  let ttlHours: number | undefined
  if (record.ttlHours !== undefined) {
    if (typeof record.ttlHours !== 'number' || !Number.isFinite(record.ttlHours)) {
      throw new ValkhanaSessionSnapshotError('ttlHours must be a finite number')
    }
    ttlHours = record.ttlHours
  }

  return { format, filters, ttlHours }
}

/**
 * Creates a Tailscale-only, capability-addressed snapshot of the active
 * profile's current organized sessions (see `valkhana-session-snapshot.ts`).
 * Creation itself requires a normal Workspace session; the resulting link
 * does not.
 */
export const Route = createFileRoute('/api/dashboard/sessions/snapshot')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        const contentTypeError = requireJsonContentType(request)
        if (contentTypeError) return contentTypeError
        try {
          const { format, filters, ttlHours } = parseSnapshotCreateRequest(
            await request.json(),
          )
          const { id, expiresAt } = await createSessionSnapshot(
            format,
            filters,
            { ttlHours },
          )
          return json({ id, expiresAt })
        } catch (error) {
          const message =
            error instanceof Error ? error.message : 'snapshot creation failed'
          const status =
            error instanceof ValkhanaSessionSnapshotError ||
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
