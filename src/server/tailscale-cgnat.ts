/**
 * Tailscale allocates client addresses from the CGNAT range 100.64.0.0/10 -
 * second octet 64-127, not the full 100.0.0.0/8 (which includes other
 * reserved/public space). Shared by auth-middleware.ts's isLocalRequest()
 * and valkhana-tailnet.ts's isTailscaleRequest() so both use the same
 * precise range rather than each defining their own.
 */
export function isTailscaleCgnatIp(ip: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(ip.trim())
  if (!match) return false
  const first = Number(match[1])
  const second = Number(match[2])
  return first === 100 && second >= 64 && second <= 127
}
