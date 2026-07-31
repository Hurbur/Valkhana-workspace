import { describe, expect, it } from 'vitest'
import {
  applyHandoffStatusPatch,
  createInitialHandoffStatus,
  isHandoffStatusStale,
} from './valkhana-handoff-status'

describe('handoff status contract', () => {
  it('marks a status stale after fifteen minutes without changing its state', () => {
    const status = createInitialHandoffStatus('default', new Date('2026-07-30T10:00:00.000Z'))

    expect(isHandoffStatusStale(status, new Date('2026-07-30T10:14:59.999Z'))).toBe(false)
    expect(isHandoffStatusStale(status, new Date('2026-07-30T10:15:00.000Z'))).toBe(true)
    expect(status.state).toBe('idle')
  })

  it('allows the explicit brain-to-terminal handoff lifecycle', () => {
    const started = applyHandoffStatusPatch(
      createInitialHandoffStatus('default', new Date('2026-07-30T10:00:00.000Z')),
      { state: 'brain-working', summary: 'Researching deployment state' },
      'brain',
      new Date('2026-07-30T10:01:00.000Z'),
    )
    const ready = applyHandoffStatusPatch(
      started,
      { state: 'ready-for-terminal', nextAction: 'Implement the route' },
      'brain',
      new Date('2026-07-30T10:02:00.000Z'),
    )
    const working = applyHandoffStatusPatch(
      ready,
      { state: 'terminal-working' },
      'terminal',
      new Date('2026-07-30T10:03:00.000Z'),
    )
    const complete = applyHandoffStatusPatch(
      working,
      { state: 'complete', summary: 'Route verified' },
      'terminal',
      new Date('2026-07-30T10:04:00.000Z'),
    )

    expect(complete).toMatchObject({
      version: 1,
      profileId: 'default',
      state: 'complete',
      actor: 'terminal',
      summary: 'Route verified',
    })
  })

  it('rejects an unsafe terminal transition before it can be written', () => {
    const idle = createInitialHandoffStatus('default', new Date('2026-07-30T10:00:00.000Z'))

    expect(() =>
      applyHandoffStatusPatch(
        idle,
        { state: 'complete' },
        'terminal',
        new Date('2026-07-30T10:01:00.000Z'),
      ),
    ).toThrow('cannot transition')
  })

  it('does not let terminal work begin from idle, Brain work, or completion', () => {
    for (const state of ['idle', 'brain-working', 'complete'] as const) {
      const current = {
        ...createInitialHandoffStatus('default', new Date('2026-07-30T10:00:00.000Z')),
        state,
      }

      expect(() =>
        applyHandoffStatusPatch(
          current,
          { state: 'terminal-working' },
          'terminal',
          new Date('2026-07-30T10:01:00.000Z'),
        ),
      ).toThrow('cannot transition')
    }
  })

  it('does not let the Brain mark a terminal handoff blocked', () => {
    const current = {
      ...createInitialHandoffStatus('default', new Date('2026-07-30T10:00:00.000Z')),
      actor: 'brain' as const,
      state: 'brain-working' as const,
    }

    expect(() =>
      applyHandoffStatusPatch(
        current,
        { state: 'blocked' },
        'brain',
        new Date('2026-07-30T10:01:00.000Z'),
      ),
    ).toThrow('cannot transition')
  })
})
