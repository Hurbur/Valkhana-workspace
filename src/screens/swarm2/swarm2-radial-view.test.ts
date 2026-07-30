import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildRadialNodePositions } from './swarm2-radial-view'

const screenSource = readFileSync(
  resolve(import.meta.dirname, 'swarm2-screen.tsx'),
  'utf8',
)
const orchestratorSource = readFileSync(
  resolve(import.meta.dirname, 'swarm2-orchestrator-card.tsx'),
  'utf8',
)

describe('Swarm2 organization view registration', () => {
  it('offers the radial organization view and renders it as a separate topology surface', () => {
    expect(orchestratorSource).toContain("['radial', 'Organization']")
    expect(screenSource).toContain("viewMode === 'radial'")
    expect(screenSource).toContain("from './swarm2-radial-view'")
  })
})

describe('Swarm2 radial node positions', () => {
  it('lays nodes around the hub in deterministic responsive percentages', () => {
    expect(buildRadialNodePositions(4)).toEqual([
      { x: 50, y: 14 },
      { x: 92, y: 50 },
      { x: 50, y: 86 },
      { x: 8, y: 50 },
    ])
  })
})
