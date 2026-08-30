import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import { requireJsonContentType } from '../../server/rate-limit'
import { dashboardFetch, ensureGatewayProbed } from '../../server/gateway-capabilities'
import { sanitizeConductorMissionGoal } from '../../server/conductor-mission-sanitize'
import { getSwarmMission } from '../../server/swarm-missions'

type ConductorSpawnBody = {
  goal?: unknown
  orchestratorModel?: unknown
  workerModel?: unknown
  projectsDir?: unknown
  maxParallel?: unknown
  supervised?: unknown
}

const CORE_AUTHORITY_MESSAGE =
  'Native Workspace mission creation and dispatch are disabled. The dashboard Conductor API is unavailable; submit the mission through ValKhana Core / Hermes when its dispatch contract is enabled.'

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function maxParallel(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(5, Math.max(1, Math.round(value)))
    : 1
}

function buildPrompt(goal: string, body: ConductorSpawnBody): string {
  const lines = [
    'You are a mission orchestrator. Execute this mission through the supported Conductor worker API.',
    `Goal: ${goal}`,
    `Maximum parallel workers: ${maxParallel(body.maxParallel)}`,
    body.supervised === true ? 'Supervised mode: require approval before each task.' : '',
    text(body.orchestratorModel) ? `Orchestrator model: ${text(body.orchestratorModel)}` : '',
    text(body.workerModel) ? `Worker model: ${text(body.workerModel)}` : '',
    text(body.projectsDir) ? `Approved projects directory: ${text(body.projectsDir)}` : '',
  ]
  return lines.filter(Boolean).join('\n')
}

async function dashboardMission(missionId: string, lines: number): Promise<Response> {
  const res = await dashboardFetch(`/api/conductor/missions/${encodeURIComponent(missionId)}?lines=${lines}`)
  const body = await res.text()
  let mission: Record<string, unknown>
  try {
    mission = JSON.parse(body) as Record<string, unknown>
  } catch {
    return json({ ok: false, error: body || `HTTP ${res.status}` }, { status: res.ok ? 502 : res.status })
  }
  if (!res.ok) {
    const error = typeof mission.detail === 'string'
      ? mission.detail
      : typeof mission.error === 'string' ? mission.error : `HTTP ${res.status}`
    return json({ ok: false, error }, { status: res.status })
  }
  return json({ ok: true, mission })
}

export const Route = createFileRoute('/api/conductor-spawn')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        const url = new URL(request.url)
        const missionId = url.searchParams.get('missionId')?.trim()
        if (!missionId) return json({ ok: false, error: 'missionId required' }, { status: 400 })
        const requestedLines = Number(url.searchParams.get('lines') || '200')
        const lines = Number.isFinite(requestedLines) ? Math.min(2000, Math.max(1, requestedLines)) : 200

        const legacy = getSwarmMission(missionId)
        if (legacy) {
          return json({
            ok: true,
            mode: 'legacy-read-only',
            mission: legacy,
            authority: 'valkhana-core/hermes',
          })
        }

        const capabilities = await ensureGatewayProbed()
        if (!capabilities.dashboard.available || !capabilities.conductor) {
          return json({ ok: false, error: 'Conductor mission not found and dashboard Conductor API is unavailable' }, { status: 404 })
        }
        return dashboardMission(missionId, lines)
      },
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        const csrfCheck = requireJsonContentType(request)
        if (csrfCheck) return csrfCheck

        const body = (await request.json().catch(() => ({}))) as ConductorSpawnBody
        const sanitized = sanitizeConductorMissionGoal(text(body.goal))
        if (!sanitized.goal) {
          return json({
            ok: false,
            error: sanitized.removedCloudflareErrorPage
              ? 'mission goal only contained a Cloudflare 5xx HTML error page; enter the original mission goal and retry'
              : 'goal required',
            warnings: sanitized.warnings,
          }, { status: 400 })
        }

        const capabilities = await ensureGatewayProbed()
        if (!capabilities.dashboard.available || !capabilities.conductor) {
          return json({ ok: false, error: CORE_AUTHORITY_MESSAGE, authority: 'valkhana-core/hermes' }, { status: 409 })
        }

        const name = `conductor-${Date.now()}`
        const res = await dashboardFetch('/api/conductor/missions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, prompt: buildPrompt(sanitized.goal, body) }),
        })
        const responseText = await res.text()
        let result: Record<string, unknown>
        try {
          result = JSON.parse(responseText) as Record<string, unknown>
        } catch {
          return json({ ok: false, error: responseText || `HTTP ${res.status}` }, { status: res.ok ? 502 : res.status })
        }
        if (!res.ok || result.error || result.detail) {
          return json({ ok: false, error: result.error || result.detail || `HTTP ${res.status}` }, { status: res.ok ? 502 : res.status })
        }
        const missionId = typeof result.id === 'string' ? result.id : name
        return json({
          ok: true,
          mode: 'dashboard',
          missionId,
          sessionKey: typeof result.session_id === 'string' ? result.session_id : null,
          jobId: missionId,
          jobName: typeof result.name === 'string' ? result.name : name,
          warnings: sanitized.warnings,
        })
      },
    },
  },
})
