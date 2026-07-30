import { describe, expect, it } from 'vitest'
import { terminalActionFor } from './handoff-status-card'

describe('terminal handoff actions', () => {
  it('offers only the safe pickup action for a Brain-ready handoff', () => {
    expect(terminalActionFor('ready-for-terminal')).toEqual({
      label: 'Start terminal work',
      state: 'terminal-working',
    })
  })

  it('does not offer a terminal action while the Brain owns the handoff', () => {
    expect(terminalActionFor('brain-working')).toBeNull()
  })
})
