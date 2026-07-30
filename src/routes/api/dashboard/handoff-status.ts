import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import { requireJsonContentType } from '../../../server/rate-limit'
import {
  applyHandoffStatusPatch,
  createInitialHandoffStatus,
  isHandoffStatusStale,
  parseHandoffStatus,
  parseHandoffStatusPatch,
  ValkhanaHandoffStatusError,
  type HandoffStatus,
} from '../../../server/valkhana-handoff-status'
import {
  resolveActiveProfileStore,
  ValkhanaProfileStoreError,
} from '../../../server/valkhana-profile-store'

async function readActiveHandoffStatus(): Promise<{
  store: Awaited<ReturnType<typeof resolveActiveProfileStore>>
  status: HandoffStatus
}> {
  const store = await resolveActiveProfileStore()
  const raw = await store.readJson('handoff-status.json')
  const status = raw
    ? parseHandoffStatus(raw)
    : createInitialHandoffStatus(store.profile.id)

  if (status.profileId !== store.profile.id) {
    throw new ValkhanaHandoffStatusError(
      'handoff status belongs to a different profile',
    )
  }
  return { store, status }
}

function errorResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : 'handoff status unavailable'
  const status =
    error instanceof ValkhanaHandoffStatusError ||
    error instanceof ValkhanaProfileStoreError
      ? 400
      : 500
  return json({ error: message }, { status })
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
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        const contentTypeError = requireJsonContentType(request)
        if (contentTypeError) return contentTypeError

        try {
          const payload = parseHandoffStatusPatch(await request.json())
          const { store, status } = await readActiveHandoffStatus()
          const updated = applyHandoffStatusPatch(status, payload, 'terminal')
          await store.writeJson('handoff-status.json', updated)
          return json({ status: updated, stale: false })
        } catch (error) {
          return errorResponse(error)
        }
      },
    },
  },
})
