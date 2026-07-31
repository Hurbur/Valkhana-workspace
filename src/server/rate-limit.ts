/**
 * Simple in-memory rate limiter (no external deps).
 * Uses a sliding window approach per key.
 */
import { getRequestIP } from '@tanstack/react-start/server'

const store = new Map<string, { timestamps: Array<number> }>()

// Cleanup old entries every 5 minutes
setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of store) {
    entry.timestamps = entry.timestamps.filter((t) => now - t < 120_000)
    if (entry.timestamps.length === 0) store.delete(key)
  }
}, 300_000)

/**
 * Check if a request is allowed under the rate limit.
 * @returns true if allowed, false if blocked
 */
export function rateLimit(
  key: string,
  maxRequests: number,
  windowMs: number,
): boolean {
  const now = Date.now()
  let entry = store.get(key)
  if (!entry) {
    entry = { timestamps: [] }
    store.set(key, entry)
  }

  // Remove timestamps outside the window
  entry.timestamps = entry.timestamps.filter((t) => now - t < windowMs)

  if (entry.timestamps.length >= maxRequests) {
    return false
  }

  entry.timestamps.push(now)
  return true
}

/**
 * Extract client IP from request for rate limiting key.
 *
 * Honors `x-forwarded-for` only when `TRUST_PROXY=1` is set — otherwise a
 * client-controlled header could trivially rotate the rate-limit key. See
 * #125. When no trusted forwarded header is present, fall back to the
 * request's remote address, or a static `local` bucket when the adapter
 * does not expose one (tests / raw fetch).
 */
export function getClientIp(request: Request): string {
  const trustProxy = (() => {
    const v = (process.env.TRUST_PROXY || '').trim().toLowerCase()
    return v === '1' || v === 'true' || v === 'yes'
  })()
  if (trustProxy) {
    const forwarded = request.headers.get('x-forwarded-for')
    const first = forwarded?.split(',')[0]?.trim()
    if (first) return first
    const real = request.headers.get('x-real-ip')?.trim()
    if (real) return real
  }
  // Fixed 2026-07-30: same root cause as auth-middleware.ts's getRequestIp -
  // a bare Fetch Request never carries a socket address, so reading
  // .remoteAddress always fell back to the 'local' bucket regardless of the
  // real caller, silently disabling per-IP rate limiting for every distinct
  // remote client. Use the request-scoped H3 event's real peer address
  // instead; fall back to 'local' only outside a live request context
  // (unit tests), matching prior behavior there exactly.
  try {
    const ip = getRequestIP({ xForwardedFor: trustProxy })
    if (ip && ip.trim()) return ip.trim()
  } catch {
    // No active H3 event - fall through to the safe default.
  }
  return 'local'
}

/**
 * Return a 429 Too Many Requests response.
 */
export function rateLimitResponse(): Response {
  return new Response(
    JSON.stringify({ error: 'Too many requests, please try again later' }),
    {
      status: 429,
      headers: { 'Content-Type': 'application/json' },
    },
  )
}

/**
 * Lightweight CSRF check: reject POST/PUT/PATCH/DELETE that don't send
 * `Content-Type: application/json`. Browsers won't set this header on
 * a simple form/navigation request, so its presence indicates a
 * programmatic call (JS fetch, curl, etc.).
 *
 * Returns `null` when the check passes, or a 415 Response to send back.
 */
export function requireJsonContentType(request: Request): Response | null {
  const method = request.method.toUpperCase()
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return null
  const ct = request.headers.get('content-type') ?? ''
  if (ct.includes('application/json')) return null
  return new Response(
    JSON.stringify({ error: 'Content-Type must be application/json' }),
    { status: 415, headers: { 'Content-Type': 'application/json' } },
  )
}

/**
 * Sanitize error for response — hide details in production.
 */
export function safeErrorMessage(err: unknown): string {
  if (process.env.NODE_ENV === 'production') {
    return 'Internal server error'
  }
  return err instanceof Error ? err.message : String(err)
}
