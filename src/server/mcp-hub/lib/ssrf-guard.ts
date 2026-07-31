/**
 * SSRF guard helpers for the MCP Hub generic-json adapter.
 *
 * Resolves all A/AAAA records for a hostname before fetching and rejects
 * any URL that resolves to a private, loopback, or link-local address.
 *
 * Cross-process locking is not needed here — this is stateless.
 */
import { lookup } from 'node:dns/promises'

// ---------------------------------------------------------------------------
// Private / reserved range checkers
// ---------------------------------------------------------------------------

/**
 * Returns true when the given IPv4 address string falls within a private,
 * loopback, link-local, or otherwise reserved range.
 */
function isPrivateIPv4(addr: string): boolean {
  const parts = addr.split('.').map(Number)
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return true // malformed — treat as unsafe
  }
  const [a, b] = parts

  // 127.0.0.0/8 — loopback
  if (a === 127) return true
  // 10.0.0.0/8 — private
  if (a === 10) return true
  // 172.16.0.0/12 — private
  if (a === 172 && b >= 16 && b <= 31) return true
  // 192.168.0.0/16 — private
  if (a === 192 && b === 168) return true
  // 169.254.0.0/16 — link-local
  if (a === 169 && b === 254) return true
  // 0.0.0.0
  if (a === 0) return true

  return false
}

/**
 * Returns true when the given IPv6 address string is a loopback, ULA, or
 * link-local address.
 *
 * Handles both full and compressed notation (Node's dns.lookup always returns
 * normalised strings, so we can rely on consistent formatting).
 */
function isPrivateIPv6(addr: string): boolean {
  const lower = addr.toLowerCase()

  // ::1 — loopback
  if (lower === '::1') return true

  // fe80::/10 — link-local (fe80 through febf)
  if (/^fe[89ab][0-9a-f]:/i.test(lower)) return true

  // fc00::/7 — ULA (fc00 through fdff)
  if (/^f[cd][0-9a-f]{2}:/i.test(lower)) return true

  return false
}

/**
 * Returns true when the IP address (v4 or v6) is private/loopback/link-local.
 */
export function isPrivateAddress(ip: string): boolean {
  // Determine address family by presence of ':'
  if (ip.includes(':')) return isPrivateIPv6(ip)
  return isPrivateIPv4(ip)
}

function isIpLiteral(hostname: string): boolean {
  return /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/.test(hostname) || hostname.includes(':')
}

/**
 * Resolves ALL A and AAAA records for a hostname and returns them, throwing
 * if any resolve to a private/loopback/link-local address, or if none
 * resolve at all. Shared by assertNotPrivate (validate-only) and
 * resolvePinnedAddress (validate-and-return-one-for-pinning) so both use
 * the exact same single DNS resolution — never two independent lookups for
 * the same request, which is what made the original two-call design
 * (validate via assertNotPrivate, then let fetch() re-resolve on its own)
 * vulnerable to DNS rebinding.
 */
async function resolveAndValidate(hostname: string): Promise<string[]> {
  const results = await Promise.allSettled([
    lookup(hostname, { all: true, family: 4 }),
    lookup(hostname, { all: true, family: 6 }),
  ])

  const addresses: string[] = []
  for (const r of results) {
    if (r.status === 'fulfilled') {
      for (const entry of r.value) {
        addresses.push(entry.address)
      }
    }
  }

  if (addresses.length === 0) {
    throw new Error(`SSRF guard: could not resolve hostname "${hostname}"`)
  }

  for (const addr of addresses) {
    if (isPrivateAddress(addr)) {
      throw new Error(
        `SSRF guard: hostname "${hostname}" resolves to private address "${addr}"`,
      )
    }
  }

  return addresses
}

// ---------------------------------------------------------------------------
// Public assertion helper
// ---------------------------------------------------------------------------

/**
 * Resolves ALL A and AAAA records for the hostname in `url` and throws if
 * ANY of them resolve to a private/loopback/link-local address.
 *
 * Also throws if the URL uses a non-HTTPS scheme or contains an IP literal
 * that is private (avoids the DNS lookup for raw-IP URLs).
 *
 * Note: this validates only — it does not pin the subsequent fetch() to the
 * validated address, so a caller using assertNotPrivate() alone followed by
 * a separate fetch() is still exposed to DNS rebinding (a second, later
 * resolution can return a different, private address). Use
 * resolvePinnedAddress() when the caller can pin its connection to a single
 * validated address; keep assertNotPrivate() only for validate-only callers
 * that don't perform a follow-up network request themselves.
 *
 * @throws {Error} with a descriptive message when SSRF risk is detected.
 */
export async function assertNotPrivate(url: string): Promise<void> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`SSRF guard: invalid URL "${url}"`)
  }

  if (parsed.protocol !== 'https:') {
    throw new Error(`SSRF guard: only HTTPS URLs are allowed (got "${parsed.protocol}")`)
  }

  const hostname = parsed.hostname

  if (isIpLiteral(hostname)) {
    if (isPrivateAddress(hostname)) {
      throw new Error(`SSRF guard: IP address "${hostname}" is in a private/reserved range`)
    }
    return
  }

  await resolveAndValidate(hostname)
}

export interface PinnedAddress {
  hostname: string
  address: string
  family: 4 | 6
}

/**
 * Validates the URL exactly like assertNotPrivate(), but additionally
 * returns ONE validated address for the caller to pin its actual network
 * connection to (e.g. via an undici Agent's connect.lookup override) — so
 * the address that gets validated is the exact same address the real
 * request connects to. This is the fix for the DNS-rebinding gap: a caller
 * that validates via assertNotPrivate() and then calls fetch() separately
 * lets fetch() re-resolve DNS on its own, and an attacker controlling DNS
 * for the target hostname can answer the two lookups differently (public
 * IP for the guard, private IP for the real connection).
 *
 * @throws {Error} with a descriptive message when SSRF risk is detected.
 */
export async function resolvePinnedAddress(url: string): Promise<PinnedAddress> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`SSRF guard: invalid URL "${url}"`)
  }

  if (parsed.protocol !== 'https:') {
    throw new Error(`SSRF guard: only HTTPS URLs are allowed (got "${parsed.protocol}")`)
  }

  const hostname = parsed.hostname

  if (isIpLiteral(hostname)) {
    if (isPrivateAddress(hostname)) {
      throw new Error(`SSRF guard: IP address "${hostname}" is in a private/reserved range`)
    }
    return { hostname, address: hostname, family: hostname.includes(':') ? 6 : 4 }
  }

  const addresses = await resolveAndValidate(hostname)
  const address = addresses[0]
  return { hostname, address, family: address.includes(':') ? 6 : 4 }
}
