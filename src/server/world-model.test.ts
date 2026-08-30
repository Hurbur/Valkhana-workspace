import { describe, expect, it } from 'vitest'
import {
  AGENTWORLD_ALIAS,
  AGENTWORLD_CONTEXT,
  AGENTWORLD_SHA256,
  getWorldModelStatus,
  validateSimulationRequest,
} from './world-model'

describe('AgentWorld auxiliary capability', () => {
  it('keeps the locked identity and bounded capsule contract', () => {
    const request = validateSimulationRequest({
      domain: 'terminal',
      environment_state: 'port 8080 is owned by slot3',
      history: 'recent service status',
      proposed_action: 'start agentworld service',
    })
    expect(request.prediction_depth).toBe('next_observation')
    expect(AGENTWORLD_ALIAS).toBe('valkhana-agentworld-35b-a3b')
    expect(AGENTWORLD_CONTEXT).toBe(114688)
    expect(AGENTWORLD_SHA256).toHaveLength(64)
  })

  it('rejects missing required state fields', () => {
    expect(() => validateSimulationRequest({ domain: 'terminal' })).toThrow(
      'required',
    )
  })

  it('reports the auxiliary service without exposing it as a picker model', () => {
    const status = getWorldModelStatus()
    expect(status.service).toBe('agentworld-llama.service')
    expect(status.alias).toBe(AGENTWORLD_ALIAS)
    expect(status.context).toBe(AGENTWORLD_CONTEXT)
    expect(status.artifactPresent).toBe(true)
    expect(status.artifactVerified).toBeNull()
  })
})
