import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import {
  assertTerminalWriterAuthorized,
  ValkhanaHandoffAuthorizationError,
} from '../../../../server/valkhana-handoff-auth'
import {
  isHandoffStatusStale,
  parseHandoffStatusPatch,
  ValkhanaHandoffStatusError,
} from '../../../../server/valkhana-handoff-status'
import { mutateActiveHandoffStatus } from '../../../../server/valkhana-handoff-service'
import { ValkhanaProfileStoreError } from '../../../../server/valkhana-profile-store'
import { requireJsonContentType } from '../../../../server/rate-limit'

function errorResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : 'Terminal handoff unavailable'
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

export const Route = createFileRoute('/api/internal/handoff/terminal')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          assertTerminalWriterAuthorized(request)
        } catch (error) {
          return errorResponse(error)
        }
        const contentTypeError = requireJsonContentType(request)
        if (contentTypeError) return contentTypeError

        try {
          const patch = parseHandoffStatusPatch(await request.json())
          const updated = await mutateActiveHandoffStatus('terminal', patch)
          return json({ status: updated, stale: isHandoffStatusStale(updated) })
        } catch (error) {
          return errorResponse(error)
        }
      },
    },
  },
})
