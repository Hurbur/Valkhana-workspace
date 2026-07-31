import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import {
  assertTailscaleRequest,
  ValkhanaTailnetError,
} from '../../../server/valkhana-tailnet'
import {
  readSessionSnapshot,
  ValkhanaSessionSnapshotError,
} from '../../../server/valkhana-session-snapshot'

/**
 * Reads a previously created session snapshot by capability id. Deliberately
 * does NOT require a Workspace login — the capability id plus the Tailscale
 * network boundary together are the access control, so this link can be
 * opened from any device on the tailnet without a password prompt. Never
 * expose this route outside Tailscale (no public Azure port).
 */
export const Route = createFileRoute('/api/dashboard/sessions/snapshot/$id')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        try {
          assertTailscaleRequest(request)
        } catch (error) {
          const message =
            error instanceof ValkhanaTailnetError
              ? error.message
              : 'forbidden'
          return json({ error: message }, { status: 403 })
        }
        try {
          const record = await readSessionSnapshot(params.id)
          if (!record) {
            return json(
              { error: 'snapshot not found or expired' },
              { status: 404 },
            )
          }
          return new Response(record.body, {
            headers: {
              'Content-Type': record.contentType,
              'Content-Disposition': `inline; filename="${record.filename}"`,
            },
          })
        } catch (error) {
          const message =
            error instanceof Error ? error.message : 'snapshot read failed'
          const status =
            error instanceof ValkhanaSessionSnapshotError ? 400 : 500
          return json({ error: message }, { status })
        }
      },
    },
  },
})
