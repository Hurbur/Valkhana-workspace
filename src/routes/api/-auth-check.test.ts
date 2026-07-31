import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  isAuthenticated,
  isPasswordProtectionEnabled,
} from '../../server/auth-middleware'
import { ensureGatewayProbed } from '../../server/gateway-capabilities'
import { Route } from './auth-check'

vi.mock('../../server/auth-middleware', () => ({
  isAuthenticated: vi.fn(),
  isPasswordProtectionEnabled: vi.fn(),
}))

vi.mock('../../server/gateway-capabilities', () => ({
  CLAUDE_DASHBOARD_URL: 'http://127.0.0.1:7860',
  ensureGatewayProbed: vi.fn(),
}))

type RouteWithHandlers = typeof Route & {
  options: {
    server: {
      handlers: {
        GET: (ctx: { request: Request }) => Promise<Response>
      }
    }
  }
}

const handler = (Route as RouteWithHandlers).options.server.handlers.GET

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(isAuthenticated).mockReturnValue(true)
  vi.mocked(isPasswordProtectionEnabled).mockReturnValue(false)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('GET /api/auth-check', () => {
  it('accepts a healthy dashboard when the legacy chat gateway is unavailable', async () => {
    vi.mocked(ensureGatewayProbed).mockResolvedValue({
      health: false,
      chatCompletions: false,
      models: false,
    } as Awaited<ReturnType<typeof ensureGatewayProbed>>)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }))),
    )

    const res = await handler({
      request: new Request('http://localhost/api/auth-check'),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      authenticated: true,
      authRequired: false,
    })
  })
})
