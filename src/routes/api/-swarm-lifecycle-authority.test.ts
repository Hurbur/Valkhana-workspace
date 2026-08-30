import { describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: (_path: string) => (options: unknown) => options,
}))
vi.mock('../../server/auth-middleware', () => ({ isAuthenticated: () => true }))
vi.mock('../../server/swarm-lifecycle', () => ({
  getSwarmLifecycleStatus: (workerId: string) => ({ workerId, contextState: 'healthy' }),
}))
vi.mock('../../server/swarm-foundation', () => ({ listSwarmWorkerIds: () => ['builder'] }))
vi.mock('../../server/swarm-roster', () => ({
  isSwarmWorkerId: (value: unknown) => typeof value === 'string' && /^[a-z][a-z0-9-]*$/.test(value),
}))

async function handlers() {
  const module = await import('./swarm-lifecycle')
  return (module as any).Route.server.handlers
}

describe('Swarm lifecycle authority boundary', () => {
  it('retains read-only context telemetry', async () => {
    const response = await (await handlers()).GET({
      request: new Request('http://localhost/api/swarm-lifecycle?workerId=builder'),
    })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      workers: [{ workerId: 'builder', contextState: 'healthy' }],
    })
  })

  it.each(['request-handoff', 'renew', 'notify-handoff-written', 'auto-sweep'])(
    'rejects legacy %s mutation as Hermes-owned',
    async (action) => {
      const response = await (await handlers()).POST({
        request: new Request('http://localhost/api/swarm-lifecycle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, workerId: 'builder' }),
        }),
      })
      expect(response.status).toBe(409)
      await expect(response.json()).resolves.toMatchObject({ ok: false, action })
    },
  )
})
