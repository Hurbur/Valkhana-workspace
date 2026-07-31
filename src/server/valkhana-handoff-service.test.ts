import { describe, expect, it, vi } from 'vitest'
import { mutateActiveHandoffStatus } from './valkhana-handoff-service'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => { resolve = next })
  return { promise, resolve }
}

describe('profile handoff mutation serialization', () => {
  it('does not let a Brain mutation overwrite terminal ownership from the same ready state', async () => {
    let persisted: Record<string, unknown> = {
      version: 1,
      profileId: 'default',
      updatedAt: '2026-07-30T10:00:00.000Z',
      actor: 'brain',
      state: 'ready-for-terminal',
    }
    const terminalWriteStarted = deferred<void>()
    const releaseTerminalWrite = deferred<void>()
    const store = {
      profile: { id: 'default', name: 'default', path: '/home/hermes-v1-test/.hermes' },
      readJson: vi.fn(async () => persisted),
      writeJson: vi.fn(async (_file: string, value: Record<string, unknown>) => {
        if (value.actor === 'terminal') {
          terminalWriteStarted.resolve()
          await releaseTerminalWrite.promise
        }
        persisted = value
      }),
    }
    const resolveStore = vi.fn(async () => store)

    const terminal = mutateActiveHandoffStatus(
      'terminal',
      { state: 'terminal-working' },
      { resolveStore },
    )
    await terminalWriteStarted.promise
    const brain = mutateActiveHandoffStatus(
      'brain',
      { state: 'brain-working' },
      { resolveStore },
    )
    releaseTerminalWrite.resolve()

    await expect(terminal).resolves.toMatchObject({
      actor: 'terminal',
      state: 'terminal-working',
    })
    await expect(brain).rejects.toThrow('cannot transition')
    expect(persisted).toMatchObject({
      actor: 'terminal',
      state: 'terminal-working',
    })
  })
})
