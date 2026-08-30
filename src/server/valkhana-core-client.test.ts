import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createHash, createHmac } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestValkhanaCore } from './valkhana-core-client'

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  vi.unstubAllEnvs()
  for (const fn of cleanup.splice(0)) await fn()
})

async function serve(
  handler: http.RequestListener,
): Promise<{ socket: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'valkhana-core-client-'))
  const socket = path.join(directory, 'core.sock')
  const server = http.createServer(handler)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socket, resolve)
  })
  cleanup.push(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
    () => rm(directory, { recursive: true, force: true }),
  )
  vi.stubEnv('VALKHANA_CORE_SOCKET', socket)
  return { socket }
}

describe('requestValkhanaCore', () => {
  it('reads an allowlisted bounded JSON response over the Unix socket', async () => {
    await serve((request, response) => {
      expect(request.url).toBe('/v1/integrations/hermes/tasks?board=project-one')
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end('{"board":"project-one","tasks":[]}')
    })

    await expect(
      requestValkhanaCore('/v1/integrations/hermes/tasks?board=project-one'),
    ).resolves.toEqual({ board: 'project-one', tasks: [] })
  })

  it('preserves a typed upstream failure and refuses arbitrary paths', async () => {
    await serve((_request, response) => {
      response.writeHead(503, { 'Content-Type': 'application/json' })
      response.end('{"error":"Hermes incompatible"}')
    })

    await expect(requestValkhanaCore('/v1/integrations/hermes/tasks')).rejects.toMatchObject({
      status: 503,
      message: 'core returned HTTP 503: Hermes incompatible',
    })
    await expect(requestValkhanaCore('/v1/arbitrary')).rejects.toMatchObject({ status: 500 })
  })

  it('sends bounded task creation only to the allowlisted endpoint', async () => {
    await serve((request, response) => {
      expect(request.method).toBe('POST')
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk) => (body += chunk))
      request.on('end', () => {
        expect(JSON.parse(body)).toEqual({ title: 'Build', idempotency_key: 'request-1' })
        response.writeHead(201, { 'Content-Type': 'application/json' })
        response.end('{"task":{"id":"t_new","status":"triage"}}')
      })
    })

    await expect(
      requestValkhanaCore('/v1/integrations/hermes/tasks', {
        method: 'POST',
        body: { title: 'Build', idempotency_key: 'request-1' },
      }),
    ).resolves.toEqual({ task: { id: 't_new', status: 'triage' } })
    await expect(
      requestValkhanaCore('/v1/health', { method: 'POST', body: {} }),
    ).rejects.toMatchObject({ status: 500 })
  })

  it('allows only typed lifecycle methods on a validated task id', async () => {
    let calls = 0
    const key = 'k'.repeat(32)
    vi.stubEnv('VALKHANA_CORE_SERVICE_TOKEN', key)
    await serve((request, response) => {
      calls += 1
      expect(request.url).toBe('/v1/integrations/hermes/tasks/t_123')
      if (request.method === 'DELETE') {
        const timestamp = request.headers['x-valkhana-timestamp']
        const nonce = request.headers['x-valkhana-nonce']
        expect(request.headers['x-valkhana-service-id']).toBe('service:valkhana-dashboard')
        expect(timestamp).toMatch(/^\d+$/)
        expect(nonce).toMatch(/^[0-9a-f]{32}$/)
        const canonical = [
          'valkhana-service-request-v1',
          'service:valkhana-dashboard',
          'DELETE',
          '/v1/integrations/hermes/tasks/t_123',
          'archive',
          createHash('sha256').update(Buffer.alloc(0)).digest('hex'),
          timestamp,
          nonce,
        ].join('\n')
        expect(request.headers['x-valkhana-signature']).toBe(
          createHmac('sha256', key).update(canonical).digest('hex'),
        )
      } else if (request.headers['x-valkhana-service-id']) {
        const timestamp = request.headers['x-valkhana-timestamp']
        const nonce = request.headers['x-valkhana-nonce']
        const canonical = [
          'valkhana-service-request-v1',
          'service:valkhana-dashboard',
          'PATCH',
          '/v1/integrations/hermes/tasks/t_123',
          'reassign',
          createHash('sha256').update('builder\nrecover worker').digest('hex'),
          timestamp,
          nonce,
        ].join('\n')
        expect(request.headers['x-valkhana-signature']).toBe(
          createHmac('sha256', key).update(canonical).digest('hex'),
        )
      }
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(
        request.method === 'DELETE'
          ? '{"task":{"id":"t_123","status":"archived"}}'
          : '{"task":{"id":"t_123","status":"blocked"}}',
      )
    })

    await expect(
      requestValkhanaCore('/v1/integrations/hermes/tasks/t_123', {
        method: 'PATCH',
        body: { action: 'block', reason: 'needs input' },
      }),
    ).resolves.toMatchObject({ task: { status: 'blocked' } })
    await expect(
      requestValkhanaCore('/v1/integrations/hermes/tasks/t_123', {
        method: 'PATCH',
        body: { action: 'reassign', profile: 'builder', reason: 'recover worker' },
      }),
    ).resolves.toMatchObject({ task: { status: 'blocked' } })
    await expect(
      requestValkhanaCore('/v1/integrations/hermes/tasks/t_123', { method: 'DELETE' }),
    ).resolves.toMatchObject({ task: { status: 'archived' } })
    expect(calls).toBe(3)
    await expect(
      requestValkhanaCore('/v1/integrations/hermes/tasks/../unsafe', { method: 'DELETE' }),
    ).rejects.toMatchObject({ status: 500 })
  })

  it('fails closed before connecting when a protected mutation has no service key', async () => {
    await expect(
      requestValkhanaCore('/v1/integrations/hermes/tasks/t_123', { method: 'DELETE' }),
    ).rejects.toMatchObject({
      status: 503,
      message: 'dashboard service authentication is unavailable',
    })
  })

  it('rejects oversized and malformed responses', async () => {
    await serve((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end('x'.repeat(65_537))
    })
    await expect(requestValkhanaCore('/v1/health')).rejects.toMatchObject({ status: 502 })
  })
})
