import { createFileRoute } from '@tanstack/react-router'
import {
  CLAUDE_API,
  ensureGatewayProbed,
  getConnectionStatus,
} from '../../server/gateway-capabilities'
import { requireLocalOrAuth } from '../../server/auth-middleware'

type PingResponse = {
  ok: boolean
  error?: string
  status?: number
  claudeUrl: string
}

export const Route = createFileRoute('/api/ping')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!requireLocalOrAuth(request)) {
          return Response.json(
            {
              ok: false,
              error: 'Authentication required',
              status: 401,
              claudeUrl: CLAUDE_API,
            } satisfies PingResponse,
            { status: 401 },
          )
        }

        // Checking caps.health alone here used to mean this always
        // reported unhealthy on a dashboard-backed deployment where the
        // legacy :8642 REST gateway is intentionally never enabled (see
        // CLAUDE.md / this project's own history - enabling it was
        // rejected as unsafe). getConnectionStatus() already models this
        // correctly elsewhere (system-metrics.ts uses it the same way):
        // 'partial'/'enhanced'/'connected' all mean the app is genuinely
        // usable via the dashboard-backed capability, even with the
        // legacy gateway down. Only a real 'disconnected' - neither the
        // gateway nor the dashboard reachable - is a true outage.
        await ensureGatewayProbed()
        if (getConnectionStatus() === 'disconnected') {
          return Response.json(
            {
              ok: false,
              error: 'Hermes Agent unavailable',
              status: 503,
              claudeUrl: CLAUDE_API,
            } satisfies PingResponse,
            { status: 503 },
          )
        }

        return Response.json(
          {
            ok: true,
            status: 200,
            claudeUrl: CLAUDE_API,
          } satisfies PingResponse,
          { status: 200 },
        )
      },
    },
  },
})
