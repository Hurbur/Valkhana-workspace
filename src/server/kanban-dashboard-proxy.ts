/**
 * Hermes Dashboard kanban plugin proxy.
 *
 * When `caps.kanban === true` (probed in gateway-capabilities), the
 * dashboard exposes the upstream Hermes kanban plugin at
 * `/api/plugins/kanban/*`. This module is a thin HTTP proxy so the
 * workspace's `/api/swarm-kanban/*` routes can talk to the dashboard
 * without touching SQLite directly.
 *
 * Why proxy at all when we also have direct-SQLite read/write
 * (see kanban-backend.ts)? Two reasons:
 *
 *   1. **Remote workspaces.** When the workspace runs in Docker/VPS
 *      and the agent runs elsewhere, the SQLite file isn't on the
 *      same filesystem. HTTP is the only viable path.
 *   2. **Single source of truth + dispatcher integration.** The
 *      dashboard's plugin_api.py wraps writes inside the same
 *      transactional helpers the dispatcher uses. Going through
 *      HTTP keeps the workspace from racing the dispatcher on
 *      `running` vs `claimed` state.
 *
 * This module is only used when `caps.kanban === true`. Otherwise
 * kanban-backend.ts falls through to the local file-backed store.
 *
 * See v2.3.0 plan.
 */
import {
  CLAUDE_DASHBOARD_URL,
  fetchDashboardToken,
} from './gateway-capabilities'
import { getValkhanaDashboardCookie, invalidateValkhanaDashboardCookie } from './valkhana-dashboard-adapter'

const PROXY_TIMEOUT_MS = 10_000

export type DashboardKanbanTask = {
  id: string
  title: string
  body?: string | null
  assignee?: string | null
  status: string
  priority?: number | null
  created_by?: string | null
  created_at?: number | null
  started_at?: number | null
  completed_at?: number | null
  workspace_kind?: string | null
  workspace_path?: string | null
}

export type DashboardKanbanBoardResponse = {
  columns: Array<{
    name: string
    tasks: Array<DashboardKanbanTask>
  }>
}

/**
 * Build headers for dashboard kanban API calls. On a standard loopback
 * install the plugin route is unauthenticated by design, so the bearer
 * token below is best-effort. This deployment runs the dashboard in
 * "gated" mode (real auth configured), where the route actually does
 * require a session - confirmed via a live 401 "no_cookie" error from
 * /api/plugins/kanban/board. Same root cause and same fix as the
 * Daily Briefing card and the chat sidebar's session list before it:
 * attach the real dashboard session cookie via the cookie-forwarding
 * login adapter (valkhana-dashboard-adapter.ts), not a bearer token.
 */
async function buildHeaders(forceRefresh = false): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  try {
    const token = await fetchDashboardToken()
    if (token) headers.Authorization = `Bearer ${token}`
  } catch {
    // Token fetch is best-effort. The plugin route works without it
    // on standard loopback installs.
  }
  try {
    if (forceRefresh) invalidateValkhanaDashboardCookie()
    const cookie = await getValkhanaDashboardCookie()
    if (cookie) headers.Cookie = cookie
  } catch {
    // No dashboard credentials configured, or login failed - proceed
    // without a cookie; the caller retries once on 401 below.
  }
  return headers
}

function dashboardUrl(path: string, params: Record<string, string | undefined> = {}): string {
  const base = CLAUDE_DASHBOARD_URL.replace(/\/+$/, '')
  const url = new URL(`${base}${path}`)
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') url.searchParams.set(key, value)
  }
  return url.toString()
}

async function dashboardFetch<T>(
  path: string,
  init: RequestInit = {},
  params: Record<string, string | undefined> = {},
): Promise<T> {
  const attempt = async (forceRefresh: boolean) => {
    const headers = await buildHeaders(forceRefresh)
    return fetch(dashboardUrl(path, params), {
      ...init,
      headers: { ...headers, ...(init.headers || {}) },
      signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
    })
  }

  let res = await attempt(false)
  if (res.status === 401) {
    res = await attempt(true)
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(
      `Dashboard kanban proxy: ${init.method || 'GET'} ${path} → ${res.status}${body ? ` — ${body.slice(0, 200)}` : ''}`,
    )
  }
  return (await res.json()) as T
}

/** Fetch the full board (all columns + tasks) from the dashboard plugin. */
export function fetchDashboardKanbanBoard(
  board?: string,
): Promise<DashboardKanbanBoardResponse> {
  return dashboardFetch<DashboardKanbanBoardResponse>(
    '/api/plugins/kanban/board',
    {},
    board ? { board } : {},
  )
}

/** Fetch one task by id. Returns null on 404. */
export async function fetchDashboardKanbanTask(
  taskId: string,
  board?: string,
): Promise<DashboardKanbanTask | null> {
  try {
    const wrapped = await dashboardFetch<{ task?: DashboardKanbanTask }>(
      `/api/plugins/kanban/tasks/${encodeURIComponent(taskId)}`,
      {},
      board ? { board } : {},
    )
    return wrapped.task ?? null
  } catch (err) {
    if (err instanceof Error && err.message.includes('→ 404')) return null
    throw err
  }
}

export type CreateDashboardKanbanTaskInput = {
  title: string
  body?: string
  assignee?: string | null
  status?: string
  priority?: number
  created_by?: string
  workspace_kind?: string
  workspace_path?: string
}

/** Create a task on the dashboard board. */
export async function createDashboardKanbanTask(
  input: CreateDashboardKanbanTaskInput,
  board?: string,
): Promise<DashboardKanbanTask> {
  const wrapped = await dashboardFetch<{ task: DashboardKanbanTask }>(
    '/api/plugins/kanban/tasks',
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
    board ? { board } : {},
  )
  return wrapped.task
}

export type UpdateDashboardKanbanTaskInput = {
  title?: string
  body?: string
  assignee?: string | null
  status?: string
  priority?: number
}

/** Patch a task on the dashboard board. */
export async function updateDashboardKanbanTask(
  taskId: string,
  updates: UpdateDashboardKanbanTaskInput,
  board?: string,
): Promise<DashboardKanbanTask> {
  const wrapped = await dashboardFetch<{ task: DashboardKanbanTask }>(
    `/api/plugins/kanban/tasks/${encodeURIComponent(taskId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify(updates),
    },
    board ? { board } : {},
  )
  return wrapped.task
}

/**
 * List boards. The dashboard kanban plugin supports multi-board (project
 * scoping); each board is a separate SQLite file under
 * `<hermes-root>/kanban/boards/<slug>/kanban.db`. The first board is
 * always `default` and lives at `<hermes-root>/kanban.db` for back-compat.
 */
export type DashboardKanbanBoard = {
  slug: string
  display_name?: string | null
  archived?: boolean
}

export function listDashboardKanbanBoards(): Promise<{
  boards: Array<DashboardKanbanBoard>
  current: string
}> {
  return dashboardFetch('/api/plugins/kanban/boards')
}
