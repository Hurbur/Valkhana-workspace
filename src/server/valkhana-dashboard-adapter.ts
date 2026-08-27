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

import { fetchProjectsTree, type ValkhanaProject } from './valkhana-gateway-ws'

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
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/

function isAllowedPath(path: string): boolean {
  if (ALLOWED_PATHS.has(path)) return true
  const prefix = '/api/sessions/'
  if (!path.startsWith(prefix)) return false
  return SESSION_ID_PATTERN.test(path.slice(prefix.length))
}

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

/**
 * Shared cookie-forwarding login for any other module that needs to reach
 * the Hermes dashboard's interactive (cookie-only) routes, e.g.
 * gateway-capabilities.ts's dashboardFetch — which previously scraped an
 * ephemeral session token from the dashboard's own root HTML page, fetched
 * WITHOUT a cookie. That page requires an authenticated session to render
 * (an anonymous request gets a 302 to /login), so the token it was looking
 * for was never actually present in the page it fetched - a chicken-and-egg
 * bug, not a config problem. This reuses the same login()/cookie-cache this
 * module already uses for the Daily Briefing / Session Organizer cards.
 */
export async function getValkhanaDashboardCookie(): Promise<string> {
  return ensureCookie()
}

/** Forces the next getValkhanaDashboardCookie() call to log in again. */
export function invalidateValkhanaDashboardCookie(): void {
  cachedCookie = null
}

async function valkhanaGet(
  path: string,
  params?: Record<string, string>,
): Promise<unknown> {
  if (!isAllowedPath(path)) {
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

/** A dashboard profile identity paired with the directory the dashboard owns. */
export interface ValkhanaActiveProfile {
  id: string
  name: string
  path: string
}

export interface ValkhanaCronJob {
  id: string
  name?: string
  status?: string
  next_run_at?: string | null
  [key: string]: unknown
}

export interface ValkhanaSession {
  id: string
  source: string | null
  model: string | null
  title: string | null
  startedAt: number
  endedAt: number | null
  lastActive: number
  active: boolean
  messageCount: number
  toolCallCount: number
  inputTokens: number
  outputTokens: number
}

export interface ValkhanaSessionPage {
  sessions: Array<ValkhanaSession>
  total: number
  limit: number
  offset: number
}

export interface ValkhanaBriefingData {
  profiles: Array<ValkhanaProfile>
  activeProfile: ValkhanaProfile | null
  sessionStats: unknown
  cronJobs: Array<ValkhanaCronJob>
  projects: Array<ValkhanaProject>
  fetchedAt: number
}

function normalizeActiveProfile(value: unknown): ValkhanaProfile | null {
  if (!value || typeof value !== 'object') return null

  const active = value as Record<string, unknown>
  const id = [active.id, active.name, active.active, active.current].find(
    (candidate): candidate is string =>
      typeof candidate === 'string' && candidate.length > 0,
  )

  if (!id) return null

  return {
    id,
    name: typeof active.name === 'string' ? active.name : id,
  }
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/**
 * Deliberately project only fields the organizer needs. Raw messages,
 * previews, prompts, model configuration, credentials, and unknown dashboard
 * fields stop at this server boundary.
 */
function normalizeSession(value: unknown): ValkhanaSession {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValkhanaAdapterError('dashboard returned an invalid session row', 502)
  }
  const row = value as Record<string, unknown>
  if (typeof row.id !== 'string' || !SESSION_ID_PATTERN.test(row.id)) {
    throw new ValkhanaAdapterError('dashboard returned an invalid session id', 502)
  }
  return {
    id: row.id,
    source: nullableString(row.source),
    model: nullableString(row.model),
    title: nullableString(row.title),
    startedAt: finiteNumber(row.started_at),
    endedAt:
      row.ended_at === null || row.ended_at === undefined
        ? null
        : finiteNumber(row.ended_at),
    lastActive: finiteNumber(row.last_active, finiteNumber(row.started_at)),
    active: row.is_active === true,
    messageCount: Math.max(0, finiteNumber(row.message_count)),
    toolCallCount: Math.max(0, finiteNumber(row.tool_call_count)),
    inputTokens: Math.max(0, finiteNumber(row.input_tokens)),
    outputTokens: Math.max(0, finiteNumber(row.output_tokens)),
  }
}

export async function fetchValkhanaSessions(options: {
  profile: string
  limit?: number
  offset?: number
}): Promise<ValkhanaSessionPage> {
  const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 50)))
  const offset = Math.max(0, Math.trunc(options.offset ?? 0))
  const response = await valkhanaGet('/api/sessions', {
    profile: options.profile,
    limit: String(limit),
    offset: String(offset),
    archived: 'include',
    order: 'recent',
  })
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw new ValkhanaAdapterError('dashboard returned an invalid session page', 502)
  }
  const page = response as Record<string, unknown>
  if (!Array.isArray(page.sessions)) {
    throw new ValkhanaAdapterError('dashboard session page has no sessions array', 502)
  }
  return {
    sessions: page.sessions.map(normalizeSession),
    total: Math.max(0, finiteNumber(page.total)),
    limit: Math.max(1, finiteNumber(page.limit, limit)),
    offset: Math.max(0, finiteNumber(page.offset, offset)),
  }
}

export async function fetchValkhanaSessionDetail(
  sessionId: string,
  profile: string,
): Promise<ValkhanaSession> {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new ValkhanaAdapterError('invalid session id', 400)
  }
  const response = await valkhanaGet(`/api/sessions/${sessionId}`, { profile })
  const session = normalizeSession(response)
  if (session.id !== sessionId) {
    throw new ValkhanaAdapterError('dashboard returned a different session id', 502)
  }
  return session
}

/**
 * Resolve the active profile exclusively from the authenticated Hermes
 * dashboard.  Callers receive a dashboard-provided directory only after the
 * active identity is matched against the dashboard's profile catalogue.
 */
export async function fetchValkhanaActiveProfile(): Promise<ValkhanaActiveProfile> {
  const [profilesResponse, activeResponse] = await Promise.all([
    valkhanaGet('/api/profiles'),
    valkhanaGet('/api/profiles/active'),
  ])
  const active = normalizeActiveProfile(activeResponse)
  const profiles =
    (profilesResponse as { profiles?: Array<ValkhanaProfile> }).profiles ?? []

  if (!active) {
    throw new ValkhanaAdapterError('dashboard did not report an active profile', 502)
  }

  const matchingProfile = profiles.find(
    (profile) => profile.id === active.id || profile.name === active.id,
  )
  if (!matchingProfile) {
    throw new ValkhanaAdapterError(
      `dashboard did not report a profile matching active identity ${active.id}`,
      502,
    )
  }
  const path = matchingProfile.path
  if (typeof path !== 'string' || path.length === 0) {
    throw new ValkhanaAdapterError(
      `dashboard did not provide a directory for active profile ${active.id}`,
      502,
    )
  }

  return {
    id: matchingProfile.id ?? matchingProfile.name ?? active.id,
    name: matchingProfile.name ?? matchingProfile.id ?? active.id,
    path,
  }
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

  const [profilesRes, activeRes, statsRes, cronRes, projectsRes] = await Promise.allSettled([
    valkhanaGet('/api/profiles'),
    valkhanaGet('/api/profiles/active'),
    valkhanaGet('/api/sessions/stats'),
    valkhanaGet('/api/cron/jobs', { profile: 'all' }),
    fetchProjectsTree(),
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
    data.activeProfile = normalizeActiveProfile(activeRes.value)
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

  if (projectsRes.status === 'fulfilled') {
    // Real per-profile registered Projects (hermes_cli/projects_db.py via
    // the projects.tree RPC) - the build plan's originally-named data
    // source, never wired in until now. Exclude the always-present
    // "__no_project__" (Home) bucket from the count so it reflects genuine
    // user-registered projects, matching Hermes's own "user-registered, not
    // auto-discovered" Projects model.
    data.projects = projectsRes.value.filter((project) => !project.isNoProject)
  } else {
    errors.projects =
      projectsRes.reason instanceof Error
        ? projectsRes.reason.message
        : String(projectsRes.reason)
  }

  return { data, errors }
}
