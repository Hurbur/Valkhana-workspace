import { describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-router', () => ({ createFileRoute: () => (options: unknown) => options }))
vi.mock('../../server/auth-middleware', () => ({ isAuthenticated: () => true }))
vi.mock('../../server/rate-limit', () => ({ requireJsonContentType: () => null }))
vi.mock('../../server/swarm-missions', () => ({ getSwarmMission: () => null }))
vi.mock('../../server/gateway-capabilities', () => ({
  ensureGatewayProbed: async () => ({ dashboard: { available: false }, conductor: false }),
  dashboardFetch: vi.fn(),
}))
vi.mock('../../server/conductor-mission-sanitize', () => ({
  sanitizeConductorMissionGoal: (goal: string) => ({ goal, warnings: [], removedCloudflareErrorPage: false }),
}))

async function handlers() {
  const module = await import('./conductor-spawn')
  return (module as any).Route.server.handlers
}

describe('Conductor authority boundary', () => {
  it('rejects native fallback when the supported dashboard API is unavailable', async () => {
    const response = await (await handlers()).POST({
      request: new Request('http://localhost/api/conductor-spawn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goal: 'Build the release' }),
      }),
    })
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      authority: 'valkhana-core/hermes',
    })
  })
})
