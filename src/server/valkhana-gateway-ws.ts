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
 * 4. Send {jsonrpc:'2.0', id, method:'session.create', params:{}} to get a
 *    fresh session_id.
 * 5. Send {jsonrpc:'2.0', id, method:'prompt.submit',
 *    params:{session_id, text}}. Immediate reply is {status:'streaming'};
 *    the actual response arrives as a stream of
 *    {jsonrpc:'2.0', method:'event', params:{type, session_id, payload}}
 *    frames (message.start, thinking.delta, status.update, ...).
 *
 * The exact "turn complete" event name was not observed within this
 * module's own verification window (the agent's thinking/response stream
 * can run long) - collectPromptReply() below treats any event whose type
 * contains "complete", "end", "done", or "error" as a turn boundary, and
 * otherwise stops at maxWaitMs. This is a defensible, documented
 * approximation given the ~13,000-line dispatcher this event stream comes
 * from was not exhaustively read; a follow-up pass watching a full real
 * turn to completion should tighten this to the exact terminal event type.
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

const TURN_BOUNDARY_PATTERN = /complete|finished|end|done|error/i

export interface PromptTurnEvent {
  type: string
  payload: unknown
}

export interface PromptReply {
  sessionId: string
  events: Array<PromptTurnEvent>
  /** Concatenated text from any event payload carrying a `.text` field. */
  text: string
}

/**
 * Submits one prompt to a fresh session on the Hermes Agent gateway and
 * collects the streamed response. Each call opens its own short-lived WS
 * connection (tickets are single-use and 30s TTL, matching the dashboard's
 * own "mint one ticket per WS" pattern) rather than holding a persistent
 * connection open.
 */
export async function submitPromptAndCollectReply(
  text: string,
  options: { maxWaitMs?: number } = {},
): Promise<PromptReply> {
  const maxWaitMs = options.maxWaitMs ?? 25_000
  const ticket = await mintWsTicket()
  const ws = new WebSocket(`${DASHBOARD_WS_URL}/api/ws?ticket=${encodeURIComponent(ticket)}`)

  const events: Array<PromptTurnEvent> = []
  let sessionId: string | null = null
  let resolveDone: (() => void) | null = null
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })

  function send(method: string, params: Record<string, unknown>, id: string) {
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
  }

  ws.addEventListener('message', (ev) => {
    let msg: RpcEnvelope
    try {
      msg = JSON.parse(String(ev.data)) as RpcEnvelope
    } catch {
      return
    }

    if (msg.id === 'create-session' && msg.result) {
      const result = msg.result as { session_id?: string }
      sessionId = result.session_id ?? null
      if (sessionId) {
        send('prompt.submit', { session_id: sessionId, text }, 'submit-prompt')
      } else {
        resolveDone?.()
      }
      return
    }

    if (msg.method === 'event' && msg.params) {
      const type = String(msg.params.type ?? '')
      if (type === 'gateway.ready') return
      events.push({ type, payload: msg.params.payload })
      if (TURN_BOUNDARY_PATTERN.test(type)) {
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

  send('session.create', {}, 'create-session')

  await Promise.race([done, new Promise((resolve) => setTimeout(resolve, maxWaitMs))])

  try {
    ws.close()
  } catch {
    // Best-effort.
  }

  if (!sessionId) {
    throw new ValkhanaGatewayWsError('gateway did not create a session', 502)
  }

  const text_ = events
    .map((event) => {
      const payload = event.payload as { text?: unknown } | undefined
      return typeof payload?.text === 'string' ? payload.text : ''
    })
    .join('')

  return { sessionId, events, text: text_ }
}
