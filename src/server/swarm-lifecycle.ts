import { execFileSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { getProfilesDir } from './claude-paths'
import { SWARM_MEMORY_ROOT } from './swarm-environment'

export type SwarmContextState = 'healthy' | 'watch' | 'handoff_required' | 'renew_required'

export type SwarmLifecyclePolicy = {
  softTokens: number
  handoffTokens: number
  hardTokens: number
}

export type SwarmLifecycleStatus = {
  workerId: string
  profilePath: string
  sessionId: string | null
  model: string | null
  title: string | null
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  messageTokens: number
  totalTokens: number
  contextState: SwarmContextState
  recommendedAction: string
  policy: SwarmLifecyclePolicy
  handoffPath: string
  handoffExists: boolean
  lastHandoffAt: number | null
}

const DEFAULT_POLICY: SwarmLifecyclePolicy = {
  softTokens: 250_000,
  handoffTokens: 400_000,
  hardTokens: 500_000,
}

const PYTHON_STATUS = `import json, sqlite3, sys
profile = sys.argv[1]
db = profile + '/state.db'
result = {"ok": False}
try:
    con = sqlite3.connect('file:' + db + '?mode=ro', uri=True)
    con.row_factory = sqlite3.Row
    sessions = con.execute("select * from sessions order by started_at desc limit 1").fetchall()
    if not sessions:
        print(json.dumps(result)); raise SystemExit
    s = sessions[0]
    session_id = s['id']
    msg_tokens = 0
    try:
        row = con.execute("select coalesce(sum(token_count), 0) as n from messages where session_id = ?", (session_id,)).fetchone()
        msg_tokens = int(row['n'] or 0)
    except Exception:
        msg_tokens = 0
    result = {
      "ok": True,
      "sessionId": session_id,
      "model": s['model'] if 'model' in s.keys() else None,
      "title": s['title'] if 'title' in s.keys() else None,
      "inputTokens": int(s['input_tokens'] or 0),
      "outputTokens": int(s['output_tokens'] or 0),
      "cacheReadTokens": int(s['cache_read_tokens'] or 0),
      "cacheWriteTokens": int(s['cache_write_tokens'] or 0),
      "reasoningTokens": int(s['reasoning_tokens'] or 0),
      "messageTokens": msg_tokens,
    }
    con.close()
except Exception as e:
    result = {"ok": False, "error": str(e)}
print(json.dumps(result))
`

function handoffPath(workerId: string): string {
  return join(SWARM_MEMORY_ROOT, 'memory', 'handoffs', 'swarm', `${workerId}-latest.md`)
}

function classify(totalTokens: number, policy: SwarmLifecyclePolicy): SwarmContextState {
  if (totalTokens >= policy.hardTokens) return 'renew_required'
  if (totalTokens >= policy.handoffTokens) return 'handoff_required'
  if (totalTokens >= policy.softTokens) return 'watch'
  return 'healthy'
}

function recommendedAction(state: SwarmContextState): string {
  switch (state) {
    case 'healthy': return 'Continue normally.'
    case 'watch': return 'Monitor context; request concise checkpoint soon.'
    case 'handoff_required': return 'Request durable handoff through the Hermes lifecycle.'
    case 'renew_required': return 'Pause new work and renew through the Hermes lifecycle after handoff.'
  }
}

export function getSwarmLifecycleStatus(
  workerId: string,
  policy = DEFAULT_POLICY,
): SwarmLifecycleStatus {
  const profilePath = join(getProfilesDir(), workerId)
  let parsed: Record<string, unknown> = {}
  try {
    const raw = execFileSync('python3', ['-c', PYTHON_STATUS, profilePath], {
      encoding: 'utf8',
      timeout: 5_000,
    })
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch {
    parsed = { ok: false }
  }
  const inputTokens = Number(parsed.inputTokens ?? 0) || 0
  const outputTokens = Number(parsed.outputTokens ?? 0) || 0
  const cacheReadTokens = Number(parsed.cacheReadTokens ?? 0) || 0
  const cacheWriteTokens = Number(parsed.cacheWriteTokens ?? 0) || 0
  const reasoningTokens = Number(parsed.reasoningTokens ?? 0) || 0
  const messageTokens = Number(parsed.messageTokens ?? 0) || 0
  const totalTokens = Math.max(
    inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens + reasoningTokens,
    messageTokens,
  )
  const state = classify(totalTokens, policy)
  const hp = handoffPath(workerId)
  let lastHandoffAt: number | null = null
  if (existsSync(hp)) {
    try { lastHandoffAt = statSync(hp).mtimeMs } catch { lastHandoffAt = null }
  }
  return {
    workerId,
    profilePath,
    sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : null,
    model: typeof parsed.model === 'string' ? parsed.model : null,
    title: typeof parsed.title === 'string' ? parsed.title : null,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    messageTokens,
    totalTokens,
    contextState: state,
    recommendedAction: recommendedAction(state),
    policy,
    handoffPath: hp,
    handoffExists: existsSync(hp),
    lastHandoffAt,
  }
}
