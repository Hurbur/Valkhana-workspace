/**
 * Server-side, read-only adapter for the Valkhana project-briefing widget.
 *
 * Option 1 design (cookie-forwarding proxy) — chosen over registering
 * hermes-agent's bearer-token seam on interactive routes, which was tried,
 * deployed, and reverted: `register_token_route()` has no fallback to
 * cookie auth, so registering it on routes the real dashboard's own
 * browser UI also uses (profiles/sessions/cron) broke that UI's normal
 * login. See Notes/Projects/valkhana-codex-handoff.md for the incident.
 *
 * How this works instead: this server logs into the real Hermes dashboard
 * itself via the same POST /auth/password-login endpoint the dashboard's
 * own login page uses (provider "basic", confirmed live via
 * GET /api/auth/providers), using credentials the operator sets in this
 * repo's own .env (HERMES_DASHBOARD_USERNAME / HERMES_DASHBOARD_PASSWORD —
 * the SAME username/password already configured on the dashboard itself).
 * The resulting session cookie is cached in-memory here and attached to
 * subsequent GET requests. On a 401, the cached cookie is dropped and one
 * fresh login + retry is attempted. Zero changes to hermes-agent itself —
 * upstream stays fully trackable via the normal installer/update path.
 *
 * Still hard-allowlisted client-side to the same 8 read-only, list/summary
 * paths as before — this is a safety net in Valkhana's own code, not
 * something Hermes's auth layer enforces for us in this design (that's the
 * real tradeoff vs. the dedicated-routes fork option — see the handoff doc).
 */

const DASHBOARD_URL = (
  process.env.HERMES_DASHBOARD_URL || 'http://127.0.0.1:7860'
).replace(/\/+$/, '')

const DASHBOARD_USERNAME = process.env.HERMES_DASHBOARD_USERNAME || ''
const DASHBOARD_PASSWORD = process.env.HERMES_DASHBOARD_PASSWORD || ''

export class ValkhanaAdapterError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message)
    this.name = 'ValkhanaAdapterError'
  }
}

// Allowlist — client-side safety net only; Hermes's own auth layer treats
// these as ordinary cookie-gated dashboard routes, same as the browser UI.
const ALLOWED_PATHS = new Set([
  '/api/profiles',
  '/api/profiles/active',
  '/api/sessions',
  '/api/sessions/search',
  '/api/sessions/stats',
  '/api/cron/jobs',
  '/api/cron/delivery-targets',
  '/api/cron/blueprints',
])

let cachedCookie: string | null = null
let loginInFlight: Promise<string> | null = null

function assertConfigured(): void {
  if (!DASHBOARD_USERNAME || !DASHBOARD_PASSWORD) {
    throw new ValkhanaAdapterError(
      'HERMES_DASHBOARD_USERNAME / HERMES_DASHBOARD_PASSWORD are not both set — nothing to authenticate against',
      503,
    )
  }
}

async function login(): Promise<string> {
  assertConfigured()
  const res = await fetch(`${DASHBOARD_URL}/auth/password-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: 'basic',
      username: DASHBOARD_USERNAME,
      password: DASHBOARD_PASSWORD,
      next: '',
    }),
  })
  if (!res.ok) {
    throw new ValkhanaAdapterError(
      `dashboard login failed with status ${res.status}`,
      res.status,
    )
  }
  const setCookie = res.headers.get('set-cookie')
  if (!setCookie) {
    throw new ValkhanaAdapterError(
      'dashboard login succeeded but returned no session cookie',
      500,
    )
  }
  // Multiple Set-Cookie headers may be folded by the fetch implementation;
  // strip attributes (path/httponly/etc.) and keep only name=value pairs.
  const cookie = setCookie
    .split(/,(?=[^;]+?=)/)
    .map((c) => c.split(';')[0].trim())
    .join('; ')
  cachedCookie = cookie
  return cookie
}

async function ensureCookie(): Promise<string> {
  if (cachedCookie) return cachedCookie
  if (!loginInFlight) {
    loginInFlight = login().finally(() => {
      loginInFlight = null
    })
  }
  return loginInFlight
}

async function valkhanaGet(
  path: string,
  params?: Record<string, string>,
): Promise<unknown> {
  if (!ALLOWED_PATHS.has(path)) {
    throw new ValkhanaAdapterError(
      `refusing to fetch un-allowlisted path: ${path}`,
      500,
    )
  }
  const url = new URL(DASHBOARD_URL + path)
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value)
    }
  }

  const doFetch = async (): Promise<Response> => {
    const cookie = await ensureCookie()
    return fetch(url.toString(), {
      method: 'GET',
      headers: { Cookie: cookie },
    })
  }

  let res: Response
  try {
    res = await doFetch()
  } catch (err) {
    throw new ValkhanaAdapterError(
      `dashboard unreachable at ${DASHBOARD_URL}: ${err instanceof Error ? err.message : String(err)}`,
      503,
    )
  }

  if (res.status === 401) {
    cachedCookie = null
    try {
      res = await doFetch()
    } catch (err) {
      throw new ValkhanaAdapterError(
        `dashboard unreachable at ${DASHBOARD_URL} on retry: ${err instanceof Error ? err.message : String(err)}`,
        503,
      )
    }
  }

  if (!res.ok) {
    throw new ValkhanaAdapterError(
      `dashboard returned ${res.status} for ${path}`,
      res.status,
    )
  }
  return res.json()
}

export interface ValkhanaProfile {
  id: string
  name?: string
  [key: string]: unknown
}

export interface ValkhanaCronJob {
  id: string
  name?: string
  status?: string
  next_run_at?: string | null
  [key: string]: unknown
}

export interface ValkhanaBriefingData {
  profiles: Array<ValkhanaProfile>
  activeProfile: ValkhanaProfile | null
  sessionStats: unknown
  cronJobs: Array<ValkhanaCronJob>
  fetchedAt: number
}

/**
 * Fetch everything the daily-briefing card needs in one call. Each section
 * fails independently — a single unreachable/erroring endpoint doesn't take
 * the whole briefing down, it just leaves that section empty.
 */
export async function fetchValkhanaBriefing(): Promise<{
  data: Partial<ValkhanaBriefingData>
  errors: Record<string, string>
}> {
  const errors: Record<string, string> = {}
  const data: Partial<ValkhanaBriefingData> = { fetchedAt: Date.now() }

  const [profilesRes, activeRes, statsRes, cronRes] = await Promise.allSettled([
    valkhanaGet('/api/profiles'),
    valkhanaGet('/api/profiles/active'),
    valkhanaGet('/api/sessions/stats'),
    valkhanaGet('/api/cron/jobs', { profile: 'all' }),
  ])

  if (profilesRes.status === 'fulfilled') {
    data.profiles =
      (profilesRes.value as { profiles?: Array<ValkhanaProfile> })?.profiles ??
      []
  } else {
    errors.profiles =
      profilesRes.reason instanceof Error
        ? profilesRes.reason.message
        : String(profilesRes.reason)
  }

  if (activeRes.status === 'fulfilled') {
    data.activeProfile = (activeRes.value as ValkhanaProfile) ?? null
  } else {
    errors.activeProfile =
      activeRes.reason instanceof Error
        ? activeRes.reason.message
        : String(activeRes.reason)
  }

  if (statsRes.status === 'fulfilled') {
    data.sessionStats = statsRes.value
  } else {
    errors.sessionStats =
      statsRes.reason instanceof Error
        ? statsRes.reason.message
        : String(statsRes.reason)
  }

  if (cronRes.status === 'fulfilled') {
    data.cronJobs = (cronRes.value as { jobs?: Array<ValkhanaCronJob> })?.jobs ?? []
  } else {
    errors.cronJobs =
      cronRes.reason instanceof Error
        ? cronRes.reason.message
        : String(cronRes.reason)
  }

  return { data, errors }
}
