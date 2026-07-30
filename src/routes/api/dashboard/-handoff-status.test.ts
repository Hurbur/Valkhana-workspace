import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: unknown) => options,
}))

vi.mock('../../../server/auth-middleware', () => ({
  isAuthenticated: vi.fn(),
  isPasswordProtectionEnabled: vi.fn(),
}))

const profile = {
  id: 'test2',
  name: 'test2',
  path: '/home/hermes-v1-test/.hermes/profiles/test2',
}
const readJson = vi.fn()
const writeJson = vi.fn()

vi.mock('../../../server/valkhana-profile-store', () => ({
  resolveActiveProfileStore: vi.fn(async () => ({ profile, readJson, writeJson })),
  ValkhanaProfileStoreError: class ValkhanaProfileStoreError extends Error {},
}))

import {
  isAuthenticated,
  isPasswordProtectionEnabled,
} from '../../../server/auth-middleware'
import { Route } from './handoff-status'

type Handlers = {
  GET: (context: { request: Request }) => Promise<Response>
  PATCH: (context: { request: Request }) => Promise<Response>
}

const handlers = (Route as { server: { handlers: Handlers } }).server.handlers

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(isAuthenticated).mockReturnValue(true)
  vi.mocked(isPasswordProtectionEnabled).mockReturnValue(true)
})

describe('/api/dashboard/handoff-status', () => {
  it('does not disclose a profile handoff status to an unauthenticated request', async () => {
    vi.mocked(isAuthenticated).mockReturnValue(false)

    const response = await handlers.GET({
      request: new Request('http://localhost/api/dashboard/handoff-status'),
    })

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'Unauthorized' })
  })

  it('returns the active profile default status when no handoff file exists', async () => {
    readJson.mockResolvedValue(null)

    const response = await handlers.GET({
      request: new Request('http://localhost/api/dashboard/handoff-status'),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      status: {
        version: 1,
        profileId: 'test2',
        actor: 'system',
        state: 'idle',
      },
      stale: false,
    })
  })

  it('accepts only a vetted terminal transition and persists it in the active profile', async () => {
    readJson.mockResolvedValue({
      version: 1,
      profileId: 'test2',
      updatedAt: '2026-07-30T10:00:00.000Z',
      actor: 'brain',
      state: 'ready-for-terminal',
      nextAction: 'Implement the route',
    })

    const response = await handlers.PATCH({
      request: new Request('http://localhost/api/dashboard/handoff-status', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          state: 'terminal-working',
          summary: 'Implementing the route',
        }),
      }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      status: {
        profileId: 'test2',
        actor: 'terminal',
        state: 'terminal-working',
        summary: 'Implementing the route',
      },
    })
    expect(writeJson).toHaveBeenCalledWith(
      'handoff-status.json',
      expect.objectContaining({ actor: 'terminal', state: 'terminal-working' }),
    )
  })

  it('rejects an unauthenticated PATCH before it reads or writes profile state', async () => {
    vi.mocked(isAuthenticated).mockReturnValue(false)

    const response = await handlers.PATCH({
      request: new Request('http://localhost/api/dashboard/handoff-status', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state: 'terminal-working' }),
      }),
    })

    expect(response.status).toBe(401)
    expect(writeJson).not.toHaveBeenCalled()
  })

  it('fails closed for PATCH when Workspace password authentication is not configured', async () => {
    vi.mocked(isPasswordProtectionEnabled).mockReturnValue(false)

    const response = await handlers.PATCH({
      request: new Request('http://localhost/api/dashboard/handoff-status', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state: 'terminal-working' }),
      }),
    })

    expect(response.status).toBe(503)
    expect(writeJson).not.toHaveBeenCalled()
  })

  it('rejects PATCH without JSON content type', async () => {
    const response = await handlers.PATCH({
      request: new Request('http://localhost/api/dashboard/handoff-status', {
        method: 'PATCH',
        headers: { 'content-type': 'text/plain' },
        body: 'state=terminal-working',
      }),
    })

    expect(response.status).toBe(415)
    expect(writeJson).not.toHaveBeenCalled()
  })

  it('rejects client source references and impossible terminal transitions', async () => {
    readJson.mockResolvedValue({
      version: 1,
      profileId: 'test2',
      updatedAt: '2026-07-30T10:00:00.000Z',
      actor: 'system',
      state: 'idle',
    })
    const response = await handlers.PATCH({
      request: new Request('http://localhost/api/dashboard/handoff-status', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          state: 'terminal-working',
          sourceRef: 'browser-must-not-set-this',
        }),
      }),
    })

    expect(response.status).toBe(400)
    expect(writeJson).not.toHaveBeenCalled()
  })

  it('refuses to write a status file belonging to another profile', async () => {
    readJson.mockResolvedValue({
      version: 1,
      profileId: 'default',
      updatedAt: '2026-07-30T10:00:00.000Z',
      actor: 'brain',
      state: 'ready-for-terminal',
    })

    const response = await handlers.PATCH({
      request: new Request('http://localhost/api/dashboard/handoff-status', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state: 'terminal-working' }),
      }),
    })

    expect(response.status).toBe(400)
    expect(writeJson).not.toHaveBeenCalled()
  })
})
