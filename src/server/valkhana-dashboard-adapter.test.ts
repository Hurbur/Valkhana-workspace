import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let fetchValkhanaBriefing: typeof import('./valkhana-dashboard-adapter').fetchValkhanaBriefing
let fetchValkhanaActiveProfile: typeof import('./valkhana-dashboard-adapter').fetchValkhanaActiveProfile
let fetchValkhanaSessions: typeof import('./valkhana-dashboard-adapter').fetchValkhanaSessions
let fetchValkhanaSessionDetail: typeof import('./valkhana-dashboard-adapter').fetchValkhanaSessionDetail

beforeEach(async () => {
  vi.resetModules()
  vi.stubEnv('HERMES_DASHBOARD_USERNAME', 'test-dashboard-user')
  vi.stubEnv('HERMES_DASHBOARD_PASSWORD', 'test-dashboard-password')
  ;({
    fetchValkhanaBriefing,
    fetchValkhanaActiveProfile,
    fetchValkhanaSessions,
    fetchValkhanaSessionDetail,
  } = await import('./valkhana-dashboard-adapter'))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('fetchValkhanaBriefing', () => {
  it('normalizes the dashboard active-profile response for the briefing card', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input)

        if (url.endsWith('/auth/password-login')) {
          return new Response('', {
            status: 200,
            headers: { 'set-cookie': 'dashboard_session=test; HttpOnly' },
          })
        }
        if (url.includes('/api/profiles/active')) {
          return Response.json({ active: 'default', current: 'default' })
        }
        if (url.includes('/api/profiles')) {
          return Response.json({ profiles: [{ id: 'default', name: 'default' }] })
        }
        if (url.includes('/api/sessions/stats')) return Response.json({ total: 0 })
        if (url.includes('/api/cron/jobs')) return Response.json({ jobs: [] })

        throw new Error(`Unexpected URL: ${url}`)
      }),
    )

    const { data, errors } = await fetchValkhanaBriefing()

    expect(errors).toEqual({})
    expect(data.activeProfile).toEqual({ id: 'default', name: 'default' })
  })
})

describe('fetchValkhanaActiveProfile', () => {
  it('returns the active profile only after matching it to a dashboard-provided path', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input)

        if (url.endsWith('/auth/password-login')) {
          return new Response('', {
            status: 200,
            headers: { 'set-cookie': 'dashboard_session=test; HttpOnly' },
          })
        }
        if (url.includes('/api/profiles/active')) {
          return Response.json({ active: 'terminal' })
        }
        if (url.includes('/api/profiles')) {
          return Response.json({
            profiles: [
              {
                name: 'terminal',
                path: '/home/hermes-v1-test/.hermes/profiles/terminal',
              },
            ],
          })
        }

        throw new Error(`Unexpected URL: ${url}`)
      }),
    )

    await expect(fetchValkhanaActiveProfile()).resolves.toEqual({
      id: 'terminal',
      name: 'terminal',
      path: '/home/hermes-v1-test/.hermes/profiles/terminal',
    })
  })
})

describe('normalized dashboard session reads', () => {
  it('returns only the explicit organizer-safe list projection', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input)
        if (url.endsWith('/auth/password-login')) {
          return new Response('', {
            status: 200,
            headers: { 'set-cookie': 'dashboard_session=test; HttpOnly' },
          })
        }
        if (url.includes('/api/sessions?')) {
          expect(url).toContain('archived=include')
          expect(url).toContain('profile=test2')
          return Response.json({
            sessions: [
              {
                id: 'session-123',
                source: 'telegram',
                model: 'openai/gpt-5.6-terra',
                title: 'Architecture review',
                started_at: 100,
                ended_at: null,
                last_active: 200,
                is_active: true,
                message_count: 4,
                tool_call_count: 2,
                input_tokens: 300,
                output_tokens: 80,
                preview: 'raw user message must not cross the adapter',
                system_prompt: 'secret prompt',
                model_config: { api_key: 'secret' },
              },
            ],
            total: 1,
            limit: 50,
            offset: 0,
          })
        }
        throw new Error(`Unexpected URL: ${url}`)
      }),
    )

    await expect(
      fetchValkhanaSessions({ profile: 'test2', limit: 50 }),
    ).resolves.toEqual({
      sessions: [
        {
          id: 'session-123',
          source: 'telegram',
          model: 'openai/gpt-5.6-terra',
          title: 'Architecture review',
          startedAt: 100,
          endedAt: null,
          lastActive: 200,
          active: true,
          messageCount: 4,
          toolCallCount: 2,
          inputTokens: 300,
          outputTokens: 80,
        },
      ],
      total: 1,
      limit: 50,
      offset: 0,
    })
  })

  it('normalizes a detail read and rejects path-like session ids before fetch', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/auth/password-login')) {
        return new Response('', {
          status: 200,
          headers: { 'set-cookie': 'dashboard_session=test; HttpOnly' },
        })
      }
      if (url.endsWith('/api/sessions/session-123?profile=test2')) {
        return Response.json({
          id: 'session-123',
          source: 'cli',
          model: null,
          title: null,
          started_at: 100,
          ended_at: 150,
          last_active: 150,
          is_active: false,
          message_count: 1,
          tool_call_count: 0,
          input_tokens: 20,
          output_tokens: 10,
          messages: [{ role: 'user', content: 'do not expose' }],
        })
      }
      throw new Error(`Unexpected URL: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      fetchValkhanaSessionDetail('session-123', 'test2'),
    ).resolves.toMatchObject({ id: 'session-123', endedAt: 150 })
    await expect(
      fetchValkhanaSessionDetail('../escape', 'test2'),
    ).rejects.toThrow('session id')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
