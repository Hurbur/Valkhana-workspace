import { afterEach, describe, expect, it, vi } from 'vitest'
import { getValKhanaCoreState, isTauriRuntime } from './valkhana-core'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

afterEach(() => {
  Reflect.deleteProperty(globalThis, '__TAURI_INTERNALS__')
  vi.clearAllMocks()
})

describe('ValKhana core bridge', () => {
  it('reports web mode without attempting desktop IPC', async () => {
    expect(isTauriRuntime()).toBe(false)
    await expect(getValKhanaCoreState()).resolves.toMatchObject({ kind: 'web' })
  })

  it('returns validated health from the Tauri command', async () => {
    Reflect.set(globalThis, '__TAURI_INTERNALS__', {})
    const { invoke } = await import('@tauri-apps/api/core')
    vi.mocked(invoke).mockResolvedValue({
      name: 'valkhana-core',
      version: '0.1.0',
      status: 'healthy',
    })

    await expect(getValKhanaCoreState()).resolves.toEqual({
      kind: 'online',
      health: {
        name: 'valkhana-core',
        version: '0.1.0',
        status: 'healthy',
      },
    })
  })

  it('turns command failures and malformed responses into offline state', async () => {
    Reflect.set(globalThis, '__TAURI_INTERNALS__', {})
    const { invoke } = await import('@tauri-apps/api/core')
    vi.mocked(invoke)
      .mockRejectedValueOnce(new Error('socket missing'))
      .mockResolvedValueOnce({ name: 'wrong-service', status: 'healthy' })

    await expect(getValKhanaCoreState()).resolves.toEqual({
      kind: 'offline',
      message: 'socket missing',
    })
    await expect(getValKhanaCoreState()).resolves.toMatchObject({ kind: 'offline' })
  })
})
