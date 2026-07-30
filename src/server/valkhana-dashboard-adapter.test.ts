import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let fetchValkhanaBriefing: typeof import('./valkhana-dashboard-adapter').fetchValkhanaBriefing

beforeEach(async () => {
  vi.resetModules()
  vi.stubEnv('HERMES_DASHBOARD_USERNAME', 'test-dashboard-user')
  vi.stubEnv('HERMES_DASHBOARD_PASSWORD', 'test-dashboard-password')
  ;({ fetchValkhanaBriefing } = await import('./valkhana-dashboard-adapter'))
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
