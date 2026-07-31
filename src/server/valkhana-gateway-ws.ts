/**
 * Real-chat sidecar for the Hermes Agent dashboard's own embedded JSON-RPC
 * gateway (`/api/ws`) - the same WebSocket the dashboard's own "Chat" tab
 * uses. This is the resolution of the "Option B" question (forking
 * hermes-agent to add a chat-completions endpoint): no fork is needed, the
 * capability already exists, unforked, on the upstream dashboard.
 *
 * Protocol (reverse-engineered from hermes_cli/web_server.py,
 * tui_gateway/{ws,server}.py, and hermes_cli/dashboard_auth/routes.py, then
 * verified against the live dashboard):
 *
 * 1. POST /auth/password-login (see valkhana-dashboard-adapter.ts) - cookie.
 * 2. POST /api/auth/ws-ticket, with that cookie - mints a single-use,
 *    30-second-TTL ticket. Browsers cannot set Authorization on a WS
 *    upgrade, and in "gated" mode (real auth configured, which this
 *    deployment has) the WS endpoint does NOT accept the cookie either -
 *    it requires this ticket as a query param instead. Sending the cookie
 *    alone (no ticket) gets an unconditional 403, which is what made this
 *    protocol look broken before the ticket-mint step was found.
 * 3. WS connect to /api/ws?ticket=<ticket>. First frame received is a
 *    `gateway.ready` event.
 * 4a. First turn in a conversation: send
 *    {jsonrpc:'2.0', id, method:'session.create', params:{}}. The result
 *    carries both an ephemeral `session_id` (only valid on this WS
 *    connection) and a durable `stored_session_id` (the DB-backed identity,
 *    confirmed via tui_gateway/methods_session.py - `session.resume` looks
 *    sessions up by this id, not the ephemeral one).
 * 4b. Continuing a conversation on a new connection: send
 *    {jsonrpc:'2.0', id, method:'session.resume', params:{session_id:
 *    <durable stored_session_id>}}. Confirmed via methods_session.py: this
 *    returns a *fresh* ephemeral `session_id` for the new connection plus
 *    `resumed` (echoing the durable id back) and the session's existing
 *    `messages`/`message_count` - the conversation history is genuinely
 *    reattached, not just referenced.
 * 5. Send {jsonrpc:'2.0', id, method:'prompt.submit',
 *    params:{session_id, text}} using whichever ephemeral session_id came
 *    back from step 4a/4b. Immediate reply is {status:'streaming'}; the
 *    actual response arrives as a stream of
 *    {jsonrpc:'2.0', method:'event', params:{type, session_id, payload}}
 *    frames (message.start, thinking.delta, status.update, ...).
 *
 * Session reuse: each HTTP call to this module still opens its own
 * short-lived WS connection (tickets are single-use, 30s TTL - there is no
 * way to hold one WS open across separate HTTP requests without a much
 * larger connection-pooling redesign this module does not attempt). What
 * *is* now reused is the underlying Hermes conversation: pass the durable
 * `sessionId` returned by a previous call back in as `options.resumeSessionId`
 * and the new connection resumes that same conversation (full history)
 * instead of starting a fresh one. Previously every call started a brand
 * new session with no way to continue a prior turn - fine for a proof of
 * concept, not for real multi-turn chat.
 *
 * Turn-completion detection: `message.complete` is confirmed as the sole
 * terminal event, on two independent grounds:
 *  1. Live probe against a real (error-path, quota-exhausted) turn - after
 *     `message.complete` fired, only unrelated background
 *     `sessions.changed` broadcasts followed.
 *  2. Direct read of the installed hermes-agent source
 *     (tui_gateway/server.py): a failed-turn helper is explicitly
 *     documented as "Close a failed turn with a terminal `message.complete`
 *     frame", and the `turn.error` handler re-emits as
 *     `_emit("message.complete", sid, {text: ..., status: "error"})`.
 *     Every turn outcome - success, error, or failure - funnels through
 *     this one frame; no other terminal event type is ever sent on this
 *     channel. (Lower-level internal event names like `turn.start` /
 *     `turn.end` / `turn.error` exist in compute_host.py/host_supervisor.py
 *     but are not what reaches this WS client - they get translated to
 *     `message.complete` first.)
 * A fully successful multi-tool-call turn was not observed live end to end
 * (blocked by the same OpenAI-Codex usage quota both times this was
 * attempted), but the source-level confirmation above does not depend on
 * that - it covers the success path too.
 */
import { WebSocket } from 'undici'
import { getValkhanaDashboardCookie } from './valkhana-dashboard-adapter'

const DASHBOARD_URL = (process.env.HERMES_DASHBOARD_URL || 'http://127.0.0.1:7860').replace(
  /\/+$/,
  '',
)
const DASHBOARD_WS_URL = DASHBOARD_URL.replace(/^http/, 'ws')

export class ValkhanaGatewayWsError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message)
    this.name = 'ValkhanaGatewayWsError'
  }
}

interface RpcEnvelope {
  jsonrpc: '2.0'
  id?: string | number | null
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: { code: number; message: string }
}

async function mintWsTicket(): Promise<string> {
  const cookie = await getValkhanaDashboardCookie()
  const res = await fetch(`${DASHBOARD_URL}/api/auth/ws-ticket`, {
    method: 'POST',
    headers: { Cookie: cookie },
  })
  if (!res.ok) {
    throw new ValkhanaGatewayWsError(
      `dashboard refused to mint a WS ticket (${res.status})`,
      res.status,
    )
  }
  const body = (await res.json()) as { ticket?: string }
  if (!body.ticket) {
    throw new ValkhanaGatewayWsError('dashboard ws-ticket response had no ticket', 502)
  }
  return body.ticket
}

const TURN_BOUNDARY_TYPES = new Set(['message.complete'])

export interface PromptTurnEvent {
  type: string
  payload: unknown
}

export interface PromptReply {
  /** Durable session id - pass back as `options.resumeSessionId` to continue this conversation. */
  sessionId: string
  events: Array<PromptTurnEvent>
  /** Concatenated text from any event payload carrying a `.text` field. */
  text: string
}

/**
 * Submits one prompt to the Hermes Agent gateway and collects the streamed
 * response. Opens its own short-lived WS connection per call (tickets are
 * single-use and 30s TTL). Pass `options.resumeSessionId` (the `sessionId`
 * from a previous PromptReply) to continue that conversation instead of
 * starting a fresh one.
 */
export async function submitPromptAndCollectReply(
  text: string,
  options: { maxWaitMs?: number; resumeSessionId?: string } = {},
): Promise<PromptReply> {
  const maxWaitMs = options.maxWaitMs ?? 25_000
  const ticket = await mintWsTicket()
  const ws = new WebSocket(`${DASHBOARD_WS_URL}/api/ws?ticket=${encodeURIComponent(ticket)}`)

  const events: Array<PromptTurnEvent> = []
  let ephemeralSessionId: string | null = null
  let durableSessionId: string | null = options.resumeSessionId ?? null
  let rpcError: ValkhanaGatewayWsError | null = null
  let resolveDone: (() => void) | null = null
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })

  function send(method: string, params: Record<string, unknown>, id: string) {
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
  }

  function startTurn(sid: string) {
    ephemeralSessionId = sid
    send('prompt.submit', { session_id: sid, text }, 'submit-prompt')
  }

  ws.addEventListener('message', (ev) => {
    let msg: RpcEnvelope
    try {
      msg = JSON.parse(String(ev.data)) as RpcEnvelope
    } catch {
      return
    }

    if (msg.id === 'create-session') {
      if (msg.error) {
        rpcError = new ValkhanaGatewayWsError(
          `session.create failed: ${msg.error.message}`,
          502,
        )
        resolveDone?.()
        return
      }
      const result = msg.result as { session_id?: string; stored_session_id?: string }
      durableSessionId = result.stored_session_id ?? result.session_id ?? null
      if (result.session_id) {
        startTurn(result.session_id)
      } else {
        rpcError = new ValkhanaGatewayWsError('session.create returned no session_id', 502)
        resolveDone?.()
      }
      return
    }

    if (msg.id === 'resume-session') {
      if (msg.error) {
        rpcError = new ValkhanaGatewayWsError(
          `session.resume failed: ${msg.error.message}`,
          404,
        )
        resolveDone?.()
        return
      }
      const result = msg.result as { session_id?: string; resumed?: string }
      durableSessionId = result.resumed ?? durableSessionId
      if (result.session_id) {
        startTurn(result.session_id)
      } else {
        rpcError = new ValkhanaGatewayWsError('session.resume returned no session_id', 502)
        resolveDone?.()
      }
      return
    }

    if (msg.method === 'event' && msg.params) {
      const type = String(msg.params.type ?? '')
      if (type === 'gateway.ready') return
      events.push({ type, payload: msg.params.payload })
      if (TURN_BOUNDARY_TYPES.has(type)) {
        resolveDone?.()
      }
    }
  })

  ws.addEventListener('error', () => resolveDone?.())
  ws.addEventListener('close', () => resolveDone?.())

  await new Promise<void>((resolve) => {
    ws.addEventListener('open', () => resolve())
    ws.addEventListener('error', () => resolve())
    setTimeout(resolve, 5_000)
  })

  if (ws.readyState !== WebSocket.OPEN) {
    throw new ValkhanaGatewayWsError('gateway WebSocket failed to open', 502)
  }

  if (options.resumeSessionId) {
    send('session.resume', { session_id: options.resumeSessionId }, 'resume-session')
  } else {
    send('session.create', {}, 'create-session')
  }

  await Promise.race([done, new Promise((resolve) => setTimeout(resolve, maxWaitMs))])

  try {
    ws.close()
  } catch {
    // Best-effort.
  }

  if (rpcError) {
    throw rpcError
  }

  if (!ephemeralSessionId || !durableSessionId) {
    throw new ValkhanaGatewayWsError('gateway did not create or resume a session', 502)
  }

  const text_ = events
    .map((event) => {
      const payload = event.payload as { text?: unknown } | undefined
      return typeof payload?.text === 'string' ? payload.text : ''
    })
    .join('')

  return { sessionId: durableSessionId, events, text: text_ }
}
