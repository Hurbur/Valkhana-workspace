import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: unknown) => options,
}))

vi.mock('../../../server/valkhana-tailnet', () => ({
  assertTailscaleRequest: vi.fn(),
  ValkhanaTailnetError: class ValkhanaTailnetError extends Error {},
}))

vi.mock('../../../server/valkhana-session-snapshot', () => ({
  readSessionSnapshot: vi.fn(),
  ValkhanaSessionSnapshotError: class ValkhanaSessionSnapshotError extends Error {},
}))

import {
  assertTailscaleRequest,
  ValkhanaTailnetError,
} from '../../../server/valkhana-tailnet'
import { readSessionSnapshot } from '../../../server/valkhana-session-snapshot'
import { Route } from './sessions.snapshot.$id'

type Handlers = {
  GET: (context: {
    request: Request
    params: { id: string }
  }) => Promise<Response>
}

const handlers = (Route as { server: { handlers: Handlers } }).server.handlers

beforeEach(() => {
  vi.resetAllMocks()
})

describe('/api/dashboard/sessions/snapshot/$id (read)', () => {
  it('rejects a non-tailnet request with 403 before reading the snapshot store', async () => {
    vi.mocked(assertTailscaleRequest).mockImplementation(() => {
      throw new ValkhanaTailnetError(
        'snapshot access is restricted to the Tailscale network',
      )
    })

    const response = await handlers.GET({
      request: new Request(
        'http://localhost/api/dashboard/sessions/snapshot/cap123',
      ),
      params: { id: 'cap123' },
    })

    expect(response.status).toBe(403)
    expect(readSessionSnapshot).not.toHaveBeenCalled()
  })

  it('returns 404 for a missing or expired snapshot without requiring login', async () => {
    vi.mocked(readSessionSnapshot).mockResolvedValue(null)

    const response = await handlers.GET({
      request: new Request(
        'http://localhost/api/dashboard/sessions/snapshot/cap123',
      ),
      params: { id: 'cap123' },
    })

    expect(response.status).toBe(404)
  })

  it('serves a live snapshot body on the tailnet with no auth check', async () => {
    vi.mocked(readSessionSnapshot).mockResolvedValue({
      id: 'cap123',
      profileId: 'test2',
      format: 'markdown',
      contentType: 'text/markdown; charset=utf-8',
      filename: 'valkhana-sessions-test2.md',
      body: '# Valkhana Sessions\n',
      createdAt: '2026-07-30T12:00:00.000Z',
      expiresAt: '2026-07-31T12:00:00.000Z',
    })

    const response = await handlers.GET({
      request: new Request(
        'http://localhost/api/dashboard/sessions/snapshot/cap123',
      ),
      params: { id: 'cap123' },
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toContain('markdown')
    expect(await response.text()).toContain('Valkhana Sessions')
  })
})
