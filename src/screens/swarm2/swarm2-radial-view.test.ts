import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildRadialNodePositions,
  getRadialWorkerStatus,
} from './swarm2-radial-view'

const screenSource = readFileSync(resolve(import.meta.dirname, 'swarm2-screen.tsx'), 'utf8')
const wiresSource = readFileSync(resolve(import.meta.dirname, 'swarm2-wires.tsx'), 'utf8')
const radialSource = readFileSync(resolve(import.meta.dirname, 'swarm2-radial-view.tsx'), 'utf8')

describe('Swarm2 organization view registration', () => {
  it('offers the radial organization view and renders it as a separate topology surface', () => {
    expect(screenSource).toContain("from './swarm2-radial-view'")
    expect(screenSource).toContain("viewMode === 'radial'")
  })
})

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

describe('Swarm2 topology wire lifecycle', () => {
  it('uses the radial hub as the wire origin and remeasures when refs change', () => {
    expect(screenSource).toContain('onHubRef={setRadialHub}')
    expect(wiresSource).toContain('version,')
    expect(wiresSource).toContain('[workers.length, version]')
  })
})

describe('Swarm2 radial accessibility and state parity', () => {
  it('keeps the hub measurable, exposes selected details, and preserves runtime state precedence', () => {
    expect(radialSource).toContain('onHubRef')
    expect(radialSource).toContain('role="region"')
    expect(radialSource).toContain('getRadialWorkerStatus')
    expect(radialSource).toContain("cs === 'done' || cs === 'handoff' || rs === 'idle'")
  })

  it('keeps offline, terminal-done, handoff, and idle statuses aligned with worker cards', () => {
    const online = { profileFound: true, gatewayState: 'running', processAlive: true }
    expect(getRadialWorkerStatus({ ...online, processAlive: false }, { currentTask: 'Build UI' })).toBe('Offline')
    expect(getRadialWorkerStatus(online, { currentTask: 'Build UI', checkpointStatus: 'done' })).toBe('Idle')
    expect(getRadialWorkerStatus(online, { currentTask: 'Build UI', checkpointStatus: 'handoff' })).toBe('Idle')
    expect(getRadialWorkerStatus(online, { currentTask: 'Build UI', state: 'idle' })).toBe('Idle')
    expect(getRadialWorkerStatus(online, { currentTask: 'Review the patch', state: 'reviewing' })).toBe('Reviewing')
  })
})
