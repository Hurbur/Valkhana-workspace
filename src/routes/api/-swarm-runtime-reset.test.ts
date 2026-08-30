import { describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: (_path: string) => (options: unknown) => options,
}))
vi.mock('../../server/auth-middleware', () => ({ isAuthenticated: () => true }))
vi.mock('../../server/rate-limit', () => ({ requireJsonContentType: () => null }))

describe('/api/swarm-runtime/reset authority boundary', () => {
  it('rejects the legacy shadow-state reset', async () => {
    const module = await import('./swarm-runtime.reset')
    const response = await (module as any).Route.server.handlers.POST({
      request: new Request('http://localhost/api/swarm-runtime/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workerIds: ['builder'], actor: 'operator', reason: 'cleanup' }),
      }),
    })
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      actor: 'operator',
      reason: 'cleanup',
    })
  })
})
