import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: unknown) => options,
}))

const mocks = vi.hoisted(() => ({
  profile: {
    id: 'default',
    name: 'default',
    path: '/home/hermes-v1-test/.hermes',
  },
  resolveActiveProfileStore: vi.fn(),
  readJson: vi.fn(),
  writeJson: vi.fn(),
}))

vi.mock('../../../../server/valkhana-profile-store', () => ({
  resolveActiveProfileStore: mocks.resolveActiveProfileStore,
  ValkhanaProfileStoreError: class ValkhanaProfileStoreError extends Error {},
}))

import { Route } from './brain'

const handler = (Route as unknown as {
  server: { handlers: { POST: (context: { request: Request }) => Promise<Response> } }
}).server.handlers.POST

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('HERMES_HANDOFF_BRAIN_TOKEN', 'configured-brain-token')
  mocks.resolveActiveProfileStore.mockResolvedValue({
    profile: mocks.profile,
    readJson: mocks.readJson,
    writeJson: mocks.writeJson,
  })
  mocks.readJson.mockResolvedValue({
    version: 1,
    profileId: 'default',
    updatedAt: '2026-07-30T10:00:00.000Z',
    actor: 'system',
    state: 'idle',
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('POST /api/internal/handoff/brain', () => {
  it('writes a Brain-owned transition with the dedicated internal authorization contract', async () => {
    const response = await handler({
      request: new Request('http://localhost/api/internal/handoff/brain', {
        method: 'POST',
        headers: {
          authorization: 'Bearer configured-brain-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          state: 'brain-working',
          summary: 'Collecting the deployment facts',
          sourceRef: 'cron:morning-briefing',
        }),
      }),
    })

    const body = await response.json()
    expect(body).toMatchObject({
      status: {
        profileId: 'default',
        actor: 'brain',
        state: 'brain-working',
        sourceRef: 'cron:morning-briefing',
      },
    })
    expect(response.status).toBe(200)
    expect(mocks.writeJson).toHaveBeenCalledWith(
      'handoff-status.json',
      expect.objectContaining({ actor: 'brain', state: 'brain-working' }),
    )
  })

  it('rejects a Brain writer with a missing token before profile I/O', async () => {
    const request = new Request('http://localhost/api/internal/handoff/brain', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: 'brain-working' }),
    })
    const response = await handler({ request })

    expect(response.status).toBe(401)
    expect(mocks.resolveActiveProfileStore).not.toHaveBeenCalled()
    expect(mocks.readJson).not.toHaveBeenCalled()
    expect(mocks.writeJson).not.toHaveBeenCalled()
  })

  it('rejects an actual wrong Bearer token before profile I/O', async () => {
    const request = new Request('http://localhost/api/internal/handoff/brain', {
      method: 'POST',
      headers: {
        authorization: 'Bearer deliberately-wrong-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ state: 'brain-working' }),
    })
    const response = await handler({ request })

    expect(request.headers.get('authorization')).toBe(
      'Bearer deliberately-wrong-token',
    )
    expect(response.status).toBe(401)
    expect(mocks.resolveActiveProfileStore).not.toHaveBeenCalled()
    expect(mocks.readJson).not.toHaveBeenCalled()
    expect(mocks.writeJson).not.toHaveBeenCalled()
  })
})
