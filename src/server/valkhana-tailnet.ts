import { getRequestIp } from './auth-middleware'
import { isTailscaleCgnatIp } from './tailscale-cgnat'

export class ValkhanaTailnetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ValkhanaTailnetError'
  }
}

const LOCAL_IPS = new Set(['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1'])

/**
 * Fails closed: an unrecognized peer is never treated as tailnet. Loopback is
 * accepted so operator curl checks from the VM itself (and same-host tests)
 * can exercise the gate, matching this codebase's existing local-request
 * convention.
 *
 * Deliberately does NOT trust the `Host` header as a tailnet signal. A
 * MagicDNS name (`*.ts.net`) in `Host` only reflects which hostname the
 * client typed to reach this server — it says nothing about the client's own
 * source address, and is fully attacker-controlled on any request regardless
 * of where it actually originated. An earlier version of this gate accepted
 * `Host: *.ts.net` as an alternative to a verified Tailscale source IP, which
 * let any caller — on or off the tailnet — bypass the network boundary this
 * function exists to enforce simply by setting that header. Source IP
 * (loopback or the 100.64.0.0/10 CGNAT range, itself only honoring
 * `x-forwarded-for`/`x-real-ip` when the operator has explicitly set
 * TRUST_PROXY) is the only signal that actually reflects the caller's real
 * network path.
 */
export function isTailscaleRequest(request: Request): boolean {
  const ip = getRequestIp(request)
  if (LOCAL_IPS.has(ip)) return true
  return isTailscaleCgnatIp(ip)
}

export function assertTailscaleRequest(request: Request): void {
  if (!isTailscaleRequest(request)) {
    throw new ValkhanaTailnetError(
      'snapshot access is restricted to the Tailscale network',
    )
  }
}
