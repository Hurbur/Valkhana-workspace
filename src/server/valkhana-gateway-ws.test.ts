import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./valkhana-dashboard-adapter', () => ({
  getValkhanaDashboardCookie: vi.fn().mockResolvedValue('hermes_session_at=fake'),
}))

const { FakeWebSocket } = vi.hoisted(() => {
class FakeWebSocket {
  static OPEN = 1
  static CLOSED = 3
  readyState = FakeWebSocket.OPEN
  listeners: Record<string, Array<(ev: unknown) => void>> = {}
  sent: Array<string> = []

  constructor(public url: string) {
    queueMicrotask(() => this.emit('open', {}))
  }

  addEventListener(type: string, fn: (ev: unknown) => void) {
    ;(this.listeners[type] ??= []).push(fn)
  }

  emit(type: string, ev: unknown) {
    for (const fn of this.listeners[type] ?? []) fn(ev)
  }

  send(data: string) {
    this.sent.push(data)
    const parsed = JSON.parse(data)
    if (parsed.method === 'session.create') {
      queueMicrotask(() =>
        this.emit('message', {
          data: JSON.stringify({
            jsonrpc: '2.0',
            id: 'create-session',
            result: { session_id: 'fake-session-1' },
          }),
        }),
      )
    } else if (parsed.method === 'prompt.submit') {
      queueMicrotask(() => {
        this.emit('message', {
          data: JSON.stringify({
            jsonrpc: '2.0',
            method: 'event',
            params: { type: 'message.start', session_id: 'fake-session-1' },
          }),
        })
        this.emit('message', {
          data: JSON.stringify({
            jsonrpc: '2.0',
            method: 'event',
            params: {
              type: 'message.complete',
              session_id: 'fake-session-1',
              payload: { text: 'four' },
            },
          }),
        })
      })
    }
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED
    this.emit('close', {})
  }
}
  return { FakeWebSocket }
})

vi.mock('undici', () => ({
  WebSocket: FakeWebSocket,
}))

import { submitPromptAndCollectReply, ValkhanaGatewayWsError } from './valkhana-gateway-ws'

function mockFetchOnce(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  })
}

beforeEach(() => {
  vi.unstubAllGlobals()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('submitPromptAndCollectReply', () => {
  it('mints a ticket, creates a session, submits the prompt, and collects the streamed reply', async () => {
    vi.stubGlobal('fetch', mockFetchOnce(200, { ticket: 'fake-ticket', ttl_seconds: 30 }))

    const reply = await submitPromptAndCollectReply('what is 2+2?')

    expect(reply.sessionId).toBe('fake-session-1')
    expect(reply.text).toBe('four')
    expect(reply.events.map((e) => e.type)).toEqual(['message.start', 'message.complete'])
  })

  it('throws a ValkhanaGatewayWsError when ticket minting fails', async () => {
    vi.stubGlobal('fetch', mockFetchOnce(401, {}))

    await expect(submitPromptAndCollectReply('hello')).rejects.toThrow(ValkhanaGatewayWsError)
  })
})
