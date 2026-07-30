import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let assertBrainWriterAuthorized: typeof import('./valkhana-handoff-auth').assertBrainWriterAuthorized

beforeEach(async () => {
  vi.resetModules()
  vi.stubEnv('HERMES_HANDOFF_BRAIN_TOKEN', 'brain-token-for-tests')
  ;({ assertBrainWriterAuthorized } = await import('./valkhana-handoff-auth'))
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('Brain handoff writer authorization', () => {
  it('rejects a missing configured Brain token instead of falling back to Workspace auth', async () => {
    vi.resetModules()
    vi.stubEnv('HERMES_HANDOFF_BRAIN_TOKEN', '')
    ;({ assertBrainWriterAuthorized } = await import('./valkhana-handoff-auth'))

    expect(() => assertBrainWriterAuthorized(new Request('http://localhost'))).toThrow(
      'not configured',
    )
  })

  it('requires the dedicated server-local Bearer token', () => {
    expect(() => assertBrainWriterAuthorized(new Request('http://localhost'))).toThrow(
      'Unauthorized',
    )
    expect(() =>
      assertBrainWriterAuthorized(
        new Request('http://localhost', {
          headers: { authorization: 'Bearer brain-token-for-tests' },
        }),
      ),
    ).not.toThrow()
  })
})
