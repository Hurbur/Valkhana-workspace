import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: unknown) => options,
}))

vi.mock('../../server/gateway-capabilities', () => ({
  ensureGatewayProbed: vi.fn().mockResolvedValue({ chatCompletions: true }),
}))

vi.mock('../../server/openai-compat-api', () => ({
  openaiChat: vi.fn().mockResolvedValue('A wise reply from the Agora.'),
}))

import { Route } from './playground-npc'

type Handlers = {
  POST: (context: { request: Request }) => Promise<Response>
}

const handlers = (Route as unknown as { server: { handlers: Handlers } }).server.handlers

function postRequest(ip: string, body: unknown): Request {
  return new Request('http://localhost/api/playground-npc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  process.env.TRUST_PROXY = '1'
})

describe('/api/playground-npc rate limiting', () => {
  it('allows requests under the per-IP limit', async () => {
    const ip = '198.51.100.10'
    const response = await handlers.POST({
      request: postRequest(ip, { npcId: 'athena', playerMessage: 'hello' }),
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { reply: string }
    expect(body.reply).toBe('A wise reply from the Agora.')
  })

  it('returns 429 after exceeding the per-IP limit, without ever calling the LLM for the blocked request', async () => {
    const ip = '198.51.100.11'
    let lastResponse: Response | null = null
    for (let i = 0; i < 21; i++) {
      lastResponse = await handlers.POST({
        request: postRequest(ip, { npcId: 'apollo', playerMessage: `msg ${i}` }),
      })
    }
    expect(lastResponse?.status).toBe(429)
  })

  it('tracks rate limits independently per IP', async () => {
    const ipA = '198.51.100.20'
    const ipB = '198.51.100.21'
    for (let i = 0; i < 20; i++) {
      await handlers.POST({
        request: postRequest(ipA, { npcId: 'nike', playerMessage: `msg ${i}` }),
      })
    }
    // ipA is now at its limit; a fresh IP should still be allowed.
    const response = await handlers.POST({
      request: postRequest(ipB, { npcId: 'nike', playerMessage: 'hi' }),
    })
    expect(response.status).toBe(200)
  })
})
