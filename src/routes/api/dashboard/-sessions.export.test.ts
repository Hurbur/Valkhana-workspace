import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: unknown) => options,
}))

vi.mock('../../../server/auth-middleware', () => ({
  isAuthenticated: vi.fn(),
}))

vi.mock('../../../server/valkhana-session-service', () => ({
  exportActiveOrganizedSessions: vi.fn(),
}))

import { isAuthenticated } from '../../../server/auth-middleware'
import { exportActiveOrganizedSessions } from '../../../server/valkhana-session-service'
import { Route } from './sessions.export'

type Handlers = {
  GET: (context: { request: Request }) => Promise<Response>
}

const handlers = (Route as unknown as { server: { handlers: Handlers } }).server.handlers

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(isAuthenticated).mockReturnValue(true)
})

describe('/api/dashboard/sessions/export', () => {
  it('rejects an unauthenticated export request', async () => {
    vi.mocked(isAuthenticated).mockReturnValue(false)
    const response = await handlers.GET({
      request: new Request('http://localhost/api/dashboard/sessions/export'),
    })
    expect(response.status).toBe(401)
    expect(exportActiveOrganizedSessions).not.toHaveBeenCalled()
  })

  it('defaults to JSON and sets a download filename', async () => {
    vi.mocked(exportActiveOrganizedSessions).mockResolvedValue({
      body: '{"version":1,"sessions":[]}\n',
      contentType: 'application/json; charset=utf-8',
      filename: 'valkhana-sessions-test2.json',
    })

    const response = await handlers.GET({
      request: new Request('http://localhost/api/dashboard/sessions/export'),
    })

    expect(exportActiveOrganizedSessions).toHaveBeenCalledWith('json', {})
    expect(response.headers.get('Content-Disposition')).toContain(
      'valkhana-sessions-test2.json',
    )
    expect(await response.text()).toContain('"version":1')
  })

  it('honors format=markdown and forwards filters', async () => {
    vi.mocked(exportActiveOrganizedSessions).mockResolvedValue({
      body: '# Valkhana Sessions\n',
      contentType: 'text/markdown; charset=utf-8',
      filename: 'valkhana-sessions-test2.md',
    })

    const response = await handlers.GET({
      request: new Request(
        'http://localhost/api/dashboard/sessions/export?format=markdown&project=Valkhana&archived=true',
      ),
    })

    expect(exportActiveOrganizedSessions).toHaveBeenCalledWith('markdown', {
      project: 'Valkhana',
      archived: true,
    })
    expect(response.headers.get('Content-Type')).toContain('markdown')
  })

  it('never leaks raw messages/prompts through the exported body', async () => {
    vi.mocked(exportActiveOrganizedSessions).mockResolvedValue({
      body: '{"version":1,"sessions":[{"id":"one","metadata":{"pinned":false}}]}\n',
      contentType: 'application/json; charset=utf-8',
      filename: 'valkhana-sessions-test2.json',
    })

    const response = await handlers.GET({
      request: new Request('http://localhost/api/dashboard/sessions/export'),
    })
    const body = await response.text()

    expect(body).not.toContain('"messages"')
    expect(body).not.toContain('"prompt"')
  })
})
