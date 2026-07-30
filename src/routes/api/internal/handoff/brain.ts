import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import {
  assertBrainWriterAuthorized,
  ValkhanaHandoffAuthorizationError,
} from '../../../../server/valkhana-handoff-auth'
import {
  applyHandoffStatusPatch,
  isHandoffStatusStale,
  parseBrainHandoffStatusPatch,
  ValkhanaHandoffStatusError,
} from '../../../../server/valkhana-handoff-status'
import { readActiveHandoffStatus } from '../../../../server/valkhana-handoff-service'
import { ValkhanaProfileStoreError } from '../../../../server/valkhana-profile-store'
import { requireJsonContentType } from '../../../../server/rate-limit'

function errorResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : 'Brain handoff unavailable'
  const status =
    error instanceof ValkhanaHandoffAuthorizationError
      ? error.status
      : error instanceof ValkhanaHandoffStatusError ||
          error instanceof ValkhanaProfileStoreError ||
          error instanceof SyntaxError
        ? 400
        : 500
  return json({ error: message }, { status })
}

/**
 * Server-local Brain writer contract. A local job invokes it with
 * `Authorization: Bearer $HERMES_HANDOFF_BRAIN_TOKEN`; browser sessions and
 * model credentials are intentionally irrelevant to this endpoint.
 */
export const Route = createFileRoute('/api/internal/handoff/brain')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          assertBrainWriterAuthorized(request)
        } catch (error) {
          return errorResponse(error)
        }
        const contentTypeError = requireJsonContentType(request)
        if (contentTypeError) return contentTypeError

        try {
          const patch = parseBrainHandoffStatusPatch(await request.json())
          const { store, status } = await readActiveHandoffStatus()
          const updated = applyHandoffStatusPatch(status, patch, 'brain')
          await store.writeJson('handoff-status.json', updated)
          return json({ status: updated, stale: isHandoffStatusStale(updated) })
        } catch (error) {
          return errorResponse(error)
        }
      },
    },
  },
})
