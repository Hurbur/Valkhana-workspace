import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: unknown) => options,
}))

vi.mock('../../../server/auth-middleware', () => ({
  isAuthenticated: vi.fn(),
}))

vi.mock('../../../server/valkhana-session-service', () => ({
  readActiveOrganizedSessions: vi.fn(),
  mutateActiveSessionOrganizer: vi.fn(),
}))

import { isAuthenticated } from '../../../server/auth-middleware'
import {
  mutateActiveSessionOrganizer,
  readActiveOrganizedSessions,
} from '../../../server/valkhana-session-service'
import { Route } from './sessions'

type Handlers = {
  GET: (context: { request: Request }) => Promise<Response>
  PATCH: (context: { request: Request }) => Promise<Response>
}

const handlers = (Route as { server: { handlers: Handlers } }).server.handlers

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(isAuthenticated).mockReturnValue(true)
})

describe('/api/dashboard/sessions', () => {
  it('rejects an unauthenticated list request', async () => {
    vi.mocked(isAuthenticated).mockReturnValue(false)
    const response = await handlers.GET({
      request: new Request('http://localhost/api/dashboard/sessions'),
    })
    expect(response.status).toBe(401)
    expect(readActiveOrganizedSessions).not.toHaveBeenCalled()
  })

  it('parses project/tag/archived/pinned query params into service filters', async () => {
    vi.mocked(readActiveOrganizedSessions).mockResolvedValue({
      profile: { id: 'test2', name: 'test2' },
      sessions: [],
      total: 0,
    })

    const response = await handlers.GET({
      request: new Request(
        'http://localhost/api/dashboard/sessions?project=Valkhana&tag=security&archived=false&pinned=true',
      ),
    })

    expect(response.status).toBe(200)
    expect(readActiveOrganizedSessions).toHaveBeenCalledWith({
      project: 'Valkhana',
      tag: 'security',
      archived: false,
      pinned: true,
    })
  })

  it('rejects an unauthenticated metadata patch', async () => {
    vi.mocked(isAuthenticated).mockReturnValue(false)
    const response = await handlers.PATCH({
      request: new Request('http://localhost/api/dashboard/sessions', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'one', pinned: true }),
      }),
    })
    expect(response.status).toBe(401)
    expect(mutateActiveSessionOrganizer).not.toHaveBeenCalled()
  })

  it('rejects a patch missing the required JSON content type', async () => {
    const response = await handlers.PATCH({
      request: new Request('http://localhost/api/dashboard/sessions', {
        method: 'PATCH',
        body: JSON.stringify({ sessionId: 'one', pinned: true }),
      }),
    })
    expect(response.status).toBe(415)
    expect(mutateActiveSessionOrganizer).not.toHaveBeenCalled()
  })

  it('forwards a vetted patch and returns the updated metadata', async () => {
    vi.mocked(mutateActiveSessionOrganizer).mockResolvedValue({
      pinned: true,
      archived: false,
      project: null,
      tags: [],
      updatedAt: '2026-07-30T12:00:00.000Z',
    })

    const response = await handlers.PATCH({
      request: new Request('http://localhost/api/dashboard/sessions', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'one', pinned: true }),
      }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      metadata: {
        pinned: true,
        archived: false,
        project: null,
        tags: [],
        updatedAt: '2026-07-30T12:00:00.000Z',
      },
    })
  })
})
