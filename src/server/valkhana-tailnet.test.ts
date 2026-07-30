import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => {
  vi.resetModules()
})

afterEach(() => {
  delete process.env.TRUST_PROXY
})

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/', { headers })
}

describe('isTailscaleRequest', () => {
  it('accepts loopback (operator curl / same-host tests), matching the existing local-request convention', async () => {
    delete process.env.TRUST_PROXY
    const { isTailscaleRequest } = await import('./valkhana-tailnet')
    // TRUST_PROXY unset -> getRequestIp falls back to '127.0.0.1'.
    expect(isTailscaleRequest(makeRequest())).toBe(true)
  })

  it('accepts a real Tailscale CGNAT address (100.64.0.0/10)', async () => {
    process.env.TRUST_PROXY = '1'
    const { isTailscaleRequest } = await import('./valkhana-tailnet')
    expect(
      isTailscaleRequest(
        makeRequest({ 'x-forwarded-for': '100.98.83.117' }),
      ),
    ).toBe(true)
  })

  it('rejects an address in 100.0.0.0/8 but outside the 100.64.0.0/10 CGNAT range', async () => {
    process.env.TRUST_PROXY = '1'
    const { isTailscaleRequest } = await import('./valkhana-tailnet')
    expect(
      isTailscaleRequest(makeRequest({ 'x-forwarded-for': '100.1.2.3' })),
    ).toBe(false)
  })

  it('rejects an ordinary public IP', async () => {
    process.env.TRUST_PROXY = '1'
    const { isTailscaleRequest } = await import('./valkhana-tailnet')
    expect(
      isTailscaleRequest(makeRequest({ 'x-forwarded-for': '203.0.113.5' })),
    ).toBe(false)
  })

  it('does NOT trust a spoofed Tailscale MagicDNS Host header from a non-tailnet source IP (regression: this was a real bypass in an earlier version)', async () => {
    process.env.TRUST_PROXY = '1'
    const { isTailscaleRequest } = await import('./valkhana-tailnet')
    expect(
      isTailscaleRequest(
        makeRequest({
          'x-forwarded-for': '203.0.113.5',
          host: 'testpilothermes.tailnet-name.ts.net:3000',
        }),
      ),
    ).toBe(false)
  })

  it('assertTailscaleRequest throws ValkhanaTailnetError for a rejected request', async () => {
    process.env.TRUST_PROXY = '1'
    const { assertTailscaleRequest, ValkhanaTailnetError } = await import(
      './valkhana-tailnet'
    )
    expect(() =>
      assertTailscaleRequest(
        makeRequest({ 'x-forwarded-for': '203.0.113.5' }),
      ),
    ).toThrow(ValkhanaTailnetError)
  })
})
