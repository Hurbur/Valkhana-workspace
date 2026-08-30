import { describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-router', () => ({ createFileRoute: () => (options: unknown) => options }))
vi.mock('../../server/auth-middleware', () => ({ isAuthenticated: () => true }))

async function post(path: 'swarm-dispatch' | 'swarm-orchestrator-loop' | 'swarm-checkpoint') {
  const modules = {
    'swarm-dispatch': () => import('./swarm-dispatch'),
    'swarm-orchestrator-loop': () => import('./swarm-orchestrator-loop'),
    'swarm-checkpoint': () => import('./swarm-checkpoint'),
  }
  const module = await modules[path]()
  return (module as any).Route.server.handlers.POST({
    request: new Request(`http://localhost/api/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }),
  })
}

describe('legacy execution authority boundaries', () => {
  it.each(['swarm-dispatch', 'swarm-orchestrator-loop', 'swarm-checkpoint'] as const)(
    'rejects %s writes as Core / Hermes-owned',
    async (path) => {
      const response = await post(path)
      expect(response.status).toBe(409)
      await expect(response.json()).resolves.toMatchObject({
        ok: false,
        authority: 'valkhana-core/hermes',
      })
    },
  )
})
