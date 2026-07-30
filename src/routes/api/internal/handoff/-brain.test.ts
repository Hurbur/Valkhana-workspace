import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: unknown) => options,
}))

const mocks = vi.hoisted(() => ({
  profile: {
    id: 'default',
    name: 'default',
    path: '/home/hermes-v1-test/.hermes',
  },
  readJson: vi.fn(),
  writeJson: vi.fn(),
  assertBrainWriterAuthorized: vi.fn(),
  ValkhanaHandoffAuthorizationError: class ValkhanaHandoffAuthorizationError extends Error {
    status: 401 | 503
    constructor(message: string, status: 401 | 503) {
      super(message)
      this.status = status
    }
  },
}))

vi.mock('../../../../server/valkhana-profile-store', () => ({
  resolveActiveProfileStore: vi.fn(async () => ({
    profile: mocks.profile,
    readJson: mocks.readJson,
    writeJson: mocks.writeJson,
  })),
  ValkhanaProfileStoreError: class ValkhanaProfileStoreError extends Error {},
}))
vi.mock('../../../../server/valkhana-handoff-auth', () => ({
  assertBrainWriterAuthorized: mocks.assertBrainWriterAuthorized,
  ValkhanaHandoffAuthorizationError: mocks.ValkhanaHandoffAuthorizationError,
}))

import { Route } from './brain'

const handler = (Route as {
  server: { handlers: { POST: (context: { request: Request }) => Promise<Response> } }
}).server.handlers.POST

beforeEach(() => {
  vi.clearAllMocks()
  mocks.readJson.mockResolvedValue({
    version: 1,
    profileId: 'default',
    updatedAt: '2026-07-30T10:00:00.000Z',
    actor: 'system',
    state: 'idle',
  })
})

describe('POST /api/internal/handoff/brain', () => {
  it('writes a Brain-owned transition with the dedicated internal authorization contract', async () => {
    const response = await handler({
      request: new Request('http://localhost/api/internal/handoff/brain', {
        method: 'POST',
        headers: {
          authorization: 'Bearer server-local-token',
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
    expect(mocks.assertBrainWriterAuthorized).toHaveBeenCalledTimes(1)
    expect(mocks.writeJson).toHaveBeenCalledWith(
      'handoff-status.json',
      expect.objectContaining({ actor: 'brain', state: 'brain-working' }),
    )
  })

  it.each(['missing token', 'wrong token'])(
    'rejects a Brain writer with %s before profile I/O',
    async (reason) => {
      mocks.assertBrainWriterAuthorized.mockImplementation(() => {
        throw new mocks.ValkhanaHandoffAuthorizationError(
          `Unauthorized: ${reason}`,
          401,
        )
      })

      const response = await handler({
        request: new Request('http://localhost/api/internal/handoff/brain', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ state: 'brain-working' }),
        }),
      })

      expect(response.status).toBe(401)
      expect(mocks.readJson).not.toHaveBeenCalled()
      expect(mocks.writeJson).not.toHaveBeenCalled()
    },
  )
})
