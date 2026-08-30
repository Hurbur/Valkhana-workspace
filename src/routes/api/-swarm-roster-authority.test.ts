import { describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: (_path: string) => (options: unknown) => options,
}))
vi.mock('../../server/auth-middleware', () => ({ isAuthenticated: () => true }))
vi.mock('../../server/swarm-foundation', () => ({ listSwarmWorkerIds: () => ['builder'] }))
vi.mock('../../server/swarm-roster', () => ({
  SWARM_ROSTER_PATH: '/repo/swarm.yaml',
  readSwarmRoster: () => ({ version: 1, workers: [{ id: 'builder' }] }),
}))

async function handlers() {
  const module = await import('./swarm-roster')
  return (module as any).Route.server.handlers
}

describe('Swarm roster authority boundary', () => {
  it('retains read-only roster projection', async () => {
    const response = await (await handlers()).GET({
      request: new Request('http://localhost/api/swarm-roster'),
    })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      path: '/repo/swarm.yaml',
      roster: { workers: [{ id: 'builder' }] },
    })
  })

  it('rejects runtime registry mutation', async () => {
    const response = await (await handlers()).POST({
      request: new Request('http://localhost/api/swarm-roster', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'builder' }),
      }),
    })
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ ok: false })
  })
})
