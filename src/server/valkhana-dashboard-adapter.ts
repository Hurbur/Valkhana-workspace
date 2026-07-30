/**
 * Server-side, read-only adapter for the Valkhana project-briefing widget.
 *
 * Separate on purpose from `gateway-capabilities.ts`'s existing
 * dashboardFetch/gatewayFetch — those assume the legacy 8642/9119 split and
 * scrape a browser session token, which doesn't work against a real Hermes
 * Agent v0.19+ dashboard's cookie-gated routes. This adapter instead uses
 * the dedicated `valkhana-read` Hermes plugin (~/.hermes/plugins/valkhana-read/,
 * a user plugin, no hermes-agent fork required) which accepts a per-VM
 * bearer secret on a small, fixed set of static read-only endpoints.
 *
 * Only ever calls GET on the routes that plugin actually registers as
 * token-authable:
 *   /api/profiles, /api/profiles/active, /api/sessions, /api/sessions/search,
 *   /api/sessions/stats, /api/cron/jobs, /api/cron/delivery-targets,
 *   /api/cron/blueprints
 *
 * The secret (`HERMES_DASHBOARD_VALKHANA_SECRET`) lives only in this
 * process's environment — never sent to the browser, never logged.
 */

const DASHBOARD_URL = (
  process.env.HERMES_DASHBOARD_URL || 'http://127.0.0.1:7860'
).replace(/\/+$/, '')

const VALKHANA_SECRET = process.env.HERMES_DASHBOARD_VALKHANA_SECRET || ''

export class ValkhanaAdapterError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message)
    this.name = 'ValkhanaAdapterError'
  }
}

function assertConfigured(): void {
  if (!VALKHANA_SECRET) {
    throw new ValkhanaAdapterError(
      'HERMES_DASHBOARD_VALKHANA_SECRET is not set — the valkhana-read Hermes plugin has nothing to authenticate against',
      503,
    )
  }
}

// Allowlist mirrors exactly what the valkhana-read plugin registers as
// token-authable. Never widen this without also widening the plugin.
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

async function valkhanaGet(
  path: string,
  params?: Record<string, string>,
): Promise<unknown> {
  assertConfigured()
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
  let res: Response
  try {
    res = await fetch(url.toString(), {
      method: 'GET',
      headers: { Authorization: `Bearer ${VALKHANA_SECRET}` },
    })
  } catch (err) {
    throw new ValkhanaAdapterError(
      `dashboard unreachable at ${DASHBOARD_URL}: ${err instanceof Error ? err.message : String(err)}`,
      503,
    )
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
 * the whole briefing down, it just leaves that section empty, same pattern
 * as `dashboard-aggregator.ts`'s existing per-section-independent design.
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
