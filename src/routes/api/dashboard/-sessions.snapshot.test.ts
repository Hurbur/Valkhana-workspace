import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: unknown) => options,
}))

vi.mock('../../../server/auth-middleware', () => ({
  isAuthenticated: vi.fn(),
}))

vi.mock('../../../server/valkhana-session-snapshot', () => ({
  createSessionSnapshot: vi.fn(),
  ValkhanaSessionSnapshotError: class ValkhanaSessionSnapshotError extends Error {},
}))

import { isAuthenticated } from '../../../server/auth-middleware'
import { createSessionSnapshot } from '../../../server/valkhana-session-snapshot'
import { Route } from './sessions.snapshot'

type Handlers = {
  POST: (context: { request: Request }) => Promise<Response>
}

const handlers = (Route as { server: { handlers: Handlers } }).server.handlers

function postRequest(body: unknown): Request {
  return new Request('http://localhost/api/dashboard/sessions/snapshot', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(isAuthenticated).mockReturnValue(true)
})

describe('/api/dashboard/sessions/snapshot (create)', () => {
  it('rejects an unauthenticated snapshot creation request', async () => {
    vi.mocked(isAuthenticated).mockReturnValue(false)
    const response = await handlers.POST({ request: postRequest({}) })
    expect(response.status).toBe(401)
    expect(createSessionSnapshot).not.toHaveBeenCalled()
  })

  it('rejects a creation request missing the JSON content type', async () => {
    const response = await handlers.POST({
      request: new Request('http://localhost/api/dashboard/sessions/snapshot', {
        method: 'POST',
        body: '{}',
      }),
    })
    expect(response.status).toBe(415)
    expect(createSessionSnapshot).not.toHaveBeenCalled()
  })

  it('defaults to json format and forwards only the filters actually present', async () => {
    vi.mocked(createSessionSnapshot).mockResolvedValue({
      id: 'cap123',
      expiresAt: '2026-07-31T12:00:00.000Z',
    })

    const response = await handlers.POST({
      request: postRequest({ project: 'Valkhana', ttlHours: 6 }),
    })

    expect(response.status).toBe(200)
    expect(createSessionSnapshot).toHaveBeenCalledWith(
      'json',
      { project: 'Valkhana' },
      { ttlHours: 6 },
    )
    expect(await response.json()).toEqual({
      id: 'cap123',
      expiresAt: '2026-07-31T12:00:00.000Z',
    })
  })

  it('accepts format=markdown', async () => {
    vi.mocked(createSessionSnapshot).mockResolvedValue({
      id: 'cap456',
      expiresAt: '2026-07-31T12:00:00.000Z',
    })

    const response = await handlers.POST({
      request: postRequest({ format: 'markdown' }),
    })

    expect(response.status).toBe(200)
    expect(createSessionSnapshot).toHaveBeenCalledWith(
      'markdown',
      {},
      { ttlHours: undefined },
    )
  })

  it('returns 400 instead of crashing when project is not a string (regression)', async () => {
    const response = await handlers.POST({
      request: postRequest({ project: 123 }),
    })
    expect(response.status).toBe(400)
    expect(createSessionSnapshot).not.toHaveBeenCalled()
  })

  it('returns 400 instead of crashing when ttlHours is not a finite number (regression)', async () => {
    const response = await handlers.POST({
      request: postRequest({ ttlHours: 'not-a-number' }),
    })
    expect(response.status).toBe(400)
    expect(createSessionSnapshot).not.toHaveBeenCalled()
  })

  it('returns 400 for a non-object body', async () => {
    const response = await handlers.POST({ request: postRequest([1, 2, 3]) })
    expect(response.status).toBe(400)
    expect(createSessionSnapshot).not.toHaveBeenCalled()
  })
})
