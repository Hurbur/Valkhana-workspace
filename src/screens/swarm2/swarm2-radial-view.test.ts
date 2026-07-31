import { describe, expect, it } from 'vitest'
import type { CrewMember } from '@/hooks/use-crew-status'
import { deriveSwarm2WorkerState } from './swarm2-worker-status'
import {
  buildRadialNodePositions,
  getRadialWorkerStatus,
} from './swarm2-radial-view'

function worker(overrides: Partial<CrewMember> = {}): CrewMember {
  return {
    id: 'builder', displayName: 'Builder', role: 'Builder', profileFound: true,
    gatewayState: 'running', processAlive: true, platforms: {}, model: 'gpt-5.6-terra', provider: 'openai',
    lastSessionTitle: null, lastSessionAt: null, sessionCount: 0, messageCount: 0, toolCallCount: 0,
    totalTokens: 0, estimatedCostUsd: null, cronJobCount: 0, assignedTaskCount: 0,
    ...overrides,
  }
}

describe('Swarm2 radial node positions', () => {
  it('keeps zero nodes empty and one worker clear of the central hub', () => {
    expect(buildRadialNodePositions(0)).toEqual([])
    expect(buildRadialNodePositions(1)).toEqual([{ x: 50, y: 82 }])
  })

  it('keeps desktop node centres inside the safe card inset', () => {
    for (const position of buildRadialNodePositions(8)) {
      expect(position.x).toBeGreaterThanOrEqual(18)
      expect(position.x).toBeLessThanOrEqual(82)
      expect(position.y).toBeGreaterThanOrEqual(16)
      expect(position.y).toBeLessThanOrEqual(84)
    }
  })
})

describe('Swarm2 radial worker state parity', () => {
  it('delegates no-task, approval, blocked, and review cases to the same canonical derivation as worker cards', () => {
    const cases = [
      { task: null, checkpoint: null, runtime: null },
      { task: 'Waiting for approval', checkpoint: null, runtime: null },
      { task: 'Build UI', checkpoint: 'blocked', runtime: null },
      { task: 'Build UI', checkpoint: null, runtime: 'blocked' },
      { task: 'Review the patch', checkpoint: null, runtime: 'reviewing' },
      { task: 'Write the specification', checkpoint: 'in_progress', runtime: 'writing' },
    ] as const

    for (const testCase of cases) {
      const expected = deriveSwarm2WorkerState(worker(), testCase.task, testCase.checkpoint, testCase.runtime)
      expect(getRadialWorkerStatus(worker(), {
        currentTask: testCase.task,
        checkpointStatus: testCase.checkpoint,
        state: testCase.runtime,
      })).toBe(expected)
    }
  })

  it('keeps offline and terminal-done/handoff states authoritative', () => {
    expect(getRadialWorkerStatus(worker({ processAlive: false }), { currentTask: 'Build UI' })).toBe('offline')
    expect(getRadialWorkerStatus(worker(), { currentTask: 'Build UI', checkpointStatus: 'done' })).toBe('idle')
    expect(getRadialWorkerStatus(worker(), { currentTask: 'Build UI', checkpointStatus: 'handoff' })).toBe('idle')
  })
})
