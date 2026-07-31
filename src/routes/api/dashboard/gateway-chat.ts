import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import { requireJsonContentType } from '../../../server/rate-limit'
import {
  submitPromptAndCollectReply,
  ValkhanaGatewayWsError,
} from '../../../server/valkhana-gateway-ws'

/**
 * Real chat capability against the Hermes Agent dashboard's own embedded
 * JSON-RPC WebSocket gateway (/api/ws) - the resolution of the "Option B"
 * research question (fork hermes-agent for a chat-completions endpoint):
 * no fork needed, this already exists on the upstream dashboard. See
 * valkhana-gateway-ws.ts for the full protocol writeup.
 */
export const Route = createFileRoute('/api/dashboard/gateway-chat')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        const contentTypeError = requireJsonContentType(request)
        if (contentTypeError) return contentTypeError

        let body: { text?: unknown }
        try {
          body = (await request.json()) as { text?: unknown }
        } catch {
          return json({ error: 'invalid JSON' }, { status: 400 })
        }
        const text = typeof body.text === 'string' ? body.text.trim() : ''
        if (!text) {
          return json({ error: 'text is required' }, { status: 400 })
        }
        if (text.length > 4000) {
          return json({ error: 'text too long' }, { status: 400 })
        }

        try {
          const reply = await submitPromptAndCollectReply(text)
          return json(reply)
        } catch (error) {
          const message = error instanceof Error ? error.message : 'gateway chat failed'
          const status = error instanceof ValkhanaGatewayWsError ? error.status : 500
          return json({ error: message }, { status })
        }
      },
    },
  },
})
