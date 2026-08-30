import { describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: (_path: string) => (options: unknown) => options,
}))
vi.mock('../../server/auth-middleware', () => ({ isAuthenticated: () => true }))
vi.mock('../../server/swarm-missions', () => ({
  SWARM_MISSIONS_PATH: '/repo/.runtime/swarm-missions.json',
  getSwarmMission: () => null,
  listSwarmMissions: () => [{ id: 'legacy-1' }],
  listSwarmReports: () => [],
}))

async function handlers() {
  const module = await import('./swarm-missions')
  return (module as any).Route.server.handlers
}

describe('Swarm mission authority boundary', () => {
  it('retains legacy history as a read-only migration projection', async () => {
    const response = await (await handlers()).GET({
      request: new Request('http://localhost/api/swarm-missions'),
    })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      missions: [{ id: 'legacy-1' }],
    })
  })

  it('rejects mission and assignment cancellation mutations', async () => {
    const response = await (await handlers()).POST({
      request: new Request('http://localhost/api/swarm-missions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cancel', missionId: 'legacy-1' }),
      }),
    })
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ ok: false, action: 'cancel' })
  })
})
