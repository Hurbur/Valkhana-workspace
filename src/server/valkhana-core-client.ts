import http from 'node:http'
import path from 'node:path'
import { createHash, createHmac, randomBytes } from 'node:crypto'

const RESPONSE_LIMIT = 64 * 1024
const REQUEST_TIMEOUT_MS = 5_000
const TASKS_PATH = '/v1/integrations/hermes/tasks'
const TASK_PATH = /^\/v1\/integrations\/hermes\/tasks\/[A-Za-z0-9_-]{1,128}$/
const ALLOWED_PATH = /^\/v1\/(?:health|integrations\/hermes\/(?:health|boards|tasks(?:\?board=[A-Za-z0-9._-]{1,128})?))$/
const DASHBOARD_SERVICE_ID = 'service:valkhana-dashboard'
const SERVICE_REQUEST_VERSION = 'valkhana-service-request-v1'

export class ValkhanaCoreError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message)
    this.name = 'ValkhanaCoreError'
  }
}

function coreSocketPath(): string {
  const configured = process.env.VALKHANA_CORE_SOCKET
  if (configured) {
    if (!path.isAbsolute(configured)) {
      throw new ValkhanaCoreError('VALKHANA_CORE_SOCKET must be absolute', 500)
    }
    return configured
  }
  const runtime = process.env.XDG_RUNTIME_DIR
  if (!runtime || !path.isAbsolute(runtime)) {
    throw new ValkhanaCoreError('XDG_RUNTIME_DIR must be an absolute path', 503)
  }
  return path.join(runtime, 'valkhana', 'core.sock')
}

function protectedAction(
  requestPath: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  body: unknown,
): { action: string; payload: Buffer } | null {
  if (!TASK_PATH.test(requestPath)) return null
  if (method === 'DELETE') return { action: 'archive', payload: Buffer.alloc(0) }
  if (method !== 'PATCH' || body === null || typeof body !== 'object' || !('action' in body)) return null
  const request = body as Record<string, unknown>
  const text = (field: string): string | null =>
    typeof request[field] === 'string' ? (request[field] as string) : null
  const optionalText = (field: string): string | null =>
    request[field] === undefined || request[field] === null
      ? ''
      : typeof request[field] === 'string'
        ? (request[field] as string)
        : null
  switch (request.action) {
    case 'complete': {
      const result = text('result')
      return result === null ? null : { action: 'complete', payload: Buffer.from(result, 'utf8') }
    }
    case 'assign': {
      const profile = optionalText('profile')
      return profile === null ? null : { action: 'assign', payload: Buffer.from(profile, 'utf8') }
    }
    case 'link_dependency':
    case 'unlink_dependency': {
      const childTaskId = text('child_task_id')
      return childTaskId === null
        ? null
        : { action: request.action, payload: Buffer.from(childTaskId, 'utf8') }
    }
    case 'promote':
    case 'reclaim':
    case 'request_changes':
    case 'reopen_review': {
      const reason = text('reason')
      return reason === null ? null : { action: request.action, payload: Buffer.from(reason, 'utf8') }
    }
    case 'reassign': {
      const profile = optionalText('profile')
      const reason = text('reason')
      return profile === null || reason === null
        ? null
        : { action: 'reassign', payload: Buffer.from(`${profile}\n${reason}`, 'utf8') }
    }
  }
  return null
}

function serviceAuthenticationHeaders(
  requestPath: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  body: unknown,
): Record<string, string> {
  const protectedRequest = protectedAction(requestPath, method, body)
  if (!protectedRequest) return {}
  const key = process.env.VALKHANA_CORE_SERVICE_TOKEN
  if (!key || Buffer.byteLength(key, 'utf8') < 32 || Buffer.byteLength(key, 'utf8') > 512) {
    throw new ValkhanaCoreError('dashboard service authentication is unavailable', 503)
  }
  const timestamp = Date.now().toString()
  const nonce = randomBytes(16).toString('hex')
  const payloadDigest = createHash('sha256').update(protectedRequest.payload).digest('hex')
  const canonical = [
    SERVICE_REQUEST_VERSION,
    DASHBOARD_SERVICE_ID,
    method,
    requestPath,
    protectedRequest.action,
    payloadDigest,
    timestamp,
    nonce,
  ].join('\n')
  const signature = createHmac('sha256', Buffer.from(key, 'utf8')).update(canonical).digest('hex')
  return {
    'X-ValKhana-Service-Id': DASHBOARD_SERVICE_ID,
    'X-ValKhana-Timestamp': timestamp,
    'X-ValKhana-Nonce': nonce,
    'X-ValKhana-Signature': signature,
  }
}

export async function requestValkhanaCore<T>(
  requestPath: string,
  options: { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: unknown } = {},
): Promise<T> {
  if (!ALLOWED_PATH.test(requestPath) && !TASK_PATH.test(requestPath)) {
    throw new ValkhanaCoreError(`refusing unallowlisted core path: ${requestPath}`, 500)
  }

  const method = options.method ?? 'GET'
  if (method === 'POST' && requestPath !== TASKS_PATH) {
    throw new ValkhanaCoreError('POST is allowed only for Hermes task creation', 500)
  }
  if ((method === 'PATCH' || method === 'DELETE') && !TASK_PATH.test(requestPath)) {
    throw new ValkhanaCoreError(`${method} is allowed only for a Hermes task`, 500)
  }
  if (method === 'GET' && options.body !== undefined) {
    throw new ValkhanaCoreError('GET requests cannot contain a body', 500)
  }
  if (method === 'PATCH' && options.body === undefined) {
    throw new ValkhanaCoreError('PATCH requires a body', 500)
  }
  if (method === 'DELETE' && options.body !== undefined) {
    throw new ValkhanaCoreError('DELETE requests cannot contain a body', 500)
  }
  const encodedBody = options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body))
  if (encodedBody && encodedBody.length > RESPONSE_LIMIT) {
    throw new ValkhanaCoreError('core request body exceeded 65536 bytes', 413)
  }
  const serviceHeaders = serviceAuthenticationHeaders(requestPath, method, options.body)

  return new Promise<T>((resolve, reject) => {
    const request = http.request(
      {
        socketPath: coreSocketPath(),
        path: requestPath,
        method,
        headers: {
          Accept: 'application/json',
          Host: 'localhost',
          ...serviceHeaders,
          ...(encodedBody
            ? {
                'Content-Type': 'application/json',
                'Content-Length': String(encodedBody.length),
              }
            : {}),
        },
      },
      (response) => {
        const chunks: Array<Buffer> = []
        let length = 0
        response.on('data', (chunk: Buffer) => {
          length += chunk.length
          if (length > RESPONSE_LIMIT) {
            response.destroy(new ValkhanaCoreError('core response exceeded 65536 bytes', 502))
            return
          }
          chunks.push(chunk)
        })
        response.on('error', reject)
        response.on('end', () => {
          const status = response.statusCode ?? 502
          const body = Buffer.concat(chunks).toString('utf8')
          let value: unknown
          try {
            value = JSON.parse(body)
          } catch {
            reject(new ValkhanaCoreError('core returned invalid JSON', 502))
            return
          }
          if (status < 200 || status >= 300) {
            const detail =
              value && typeof value === 'object' && 'error' in value && typeof value.error === 'string'
                ? `: ${value.error}`
                : ''
            reject(new ValkhanaCoreError(`core returned HTTP ${status}${detail}`, status))
            return
          }
          resolve(value as T)
        })
      },
    )
    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy(new ValkhanaCoreError('core request timed out', 504))
    })
    request.on('error', (error) => {
      reject(
        error instanceof ValkhanaCoreError
          ? error
          : new ValkhanaCoreError(`core unavailable: ${error.message}`, 503),
      )
    })
    request.end(encodedBody)
  })
}
