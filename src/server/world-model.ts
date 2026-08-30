import fs from 'node:fs'
import { execFileSync } from 'node:child_process'

export const AGENTWORLD_SERVICE = 'agentworld-llama.service'
export const AGENTWORLD_ALIAS = 'valkhana-agentworld-35b-a3b'
export const AGENTWORLD_PORT = 8080
export const AGENTWORLD_CONTEXT = 114688
export const AGENTWORLD_ARTIFACT =
  '/mnt/linux-data/AI/models/valkhana-world-models/qwen-agentworld-35b-a3b/Qwen-AgentWorld-35B-A3B-APEX-I-Compact.gguf'
export const AGENTWORLD_SHA256 =
  'a6988d8c542e5307be35ee75dd9bb194ee303bb6eb205a1a6a86ef204ace7aa7'
const BASE_URL = `http://127.0.0.1:${AGENTWORLD_PORT}`
const MAX_FIELD_CHARS = 180_000
const MAX_TOTAL_CHARS = 500_000
const COMMAND_TIMEOUT_MS = 10_000
const MANAGED_FLEET_SERVICES = [
  'ornith-9b.service',
  'gemma-4-26b.service',
  'ornith-llama.service',
  'agents-a1.service',
  'qwen3.8.service',
]

export type WorldModelSimulationRequest = {
  domain: string
  environment_state: string
  history?: string
  proposed_action: string
  constraints?: string
  prediction_depth?: 'next_observation' | string
}

export type WorldModelSimulationResponse = {
  predicted_observation: string
  predicted_side_effects: Array<string>
  uncertainties: Array<string>
}

export type WorldModelStatus = {
  service: string
  enabled: boolean | null
  active: boolean
  port: number
  portOwner: string | null
  artifactPresent: boolean
  artifactSha256: string | null
  artifactVerified: boolean | null
  alias: string
  context: number
  runtimeIdentity: { alias: string; context: number } | null
}

function runSystemctl(args: Array<string>): string {
  try {
    return execFileSync('systemctl', args, {
      encoding: 'utf8',
      timeout: COMMAND_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return ''
  }
}

function runSystemctlCommand(args: Array<string>): boolean {
  try {
    execFileSync('systemctl', args, {
      encoding: 'utf8',
      timeout: COMMAND_TIMEOUT_MS,
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    return true
  } catch {
    return false
  }
}

function systemctl(args: Array<string>): string {
  const direct = runSystemctl(['--user', ...args])
  if (direct) return direct
  return runSystemctl([
    '--user',
    '-M',
    `${process.env.USER ?? 'jbhurbie'}@.host`,
    ...args,
  ])
}

function systemctlCommand(args: Array<string>): boolean {
  if (runSystemctlCommand(['--user', ...args])) return true
  return runSystemctlCommand([
    '--user',
    '-M',
    `${process.env.USER ?? 'jbhurbie'}@.host`,
    ...args,
  ])
}

function portOwner(): string | null {
  try {
    const output = execFileSync('ss', ['-lntp'], {
      encoding: 'utf8',
      timeout: COMMAND_TIMEOUT_MS,
    })
    const line = output.split('\n').find((entry) => entry.includes(':8080 '))
    if (!line) return null
    const match = line.match(/users:\(\("([^"]+)"[^)]*pid=(\d+)/)
    return match ? `${match[1]} (pid ${match[2]})` : 'unknown'
  } catch {
    return null
  }
}

function artifactSha256(): string | null {
  try {
    return (
      execFileSync('sha256sum', [AGENTWORLD_ARTIFACT], {
        encoding: 'utf8',
        timeout: 120_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .trim()
        .split(/\s+/)[0] || null
    )
  } catch {
    return null
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function modelIdentity(
  payload: unknown,
): { alias: string; context: number } | null {
  const root = asObject(payload)
  const data: Array<unknown> = Array.isArray(root.data) ? root.data : []
  const model = asObject(data[0])
  const alias = typeof model.id === 'string' ? model.id : ''
  const meta = asObject(model.meta)
  const defaults = asObject(root.default_generation_settings)
  const contextRaw =
    root.context_length ??
    root.n_ctx ??
    root.n_ctx_train ??
    model.context_length ??
    model.n_ctx_train ??
    meta.n_ctx_train ??
    defaults.n_ctx
  const context = typeof contextRaw === 'number' ? contextRaw : 0
  return alias ? { alias, context } : null
}

export async function readWorldModelIdentity(): Promise<{
  alias: string
  context: number
} | null> {
  try {
    const response = await fetch(`${BASE_URL}/v1/models`, {
      signal: AbortSignal.timeout(3_000),
    })
    if (!response.ok) return null
    const payload = await response.json()
    const identity = modelIdentity(payload)
    if (!identity || identity.context === AGENTWORLD_CONTEXT) return identity
    // llama-server exposes the effective runtime context through /props on
    // versions whose OpenAI model listing only reports training metadata.
    const props = await fetch(`${BASE_URL}/props`, {
      signal: AbortSignal.timeout(3_000),
    })
    if (!props.ok) return identity
    const propsIdentity = modelIdentity({
      ...asObject(await props.json()),
      data: [{ id: identity.alias }],
    })
    return propsIdentity
      ? { alias: identity.alias, context: propsIdentity.context }
      : identity
  } catch {
    return null
  }
}

export function getWorldModelStatus(): WorldModelStatus {
  return {
    service: AGENTWORLD_SERVICE,
    enabled: (() => {
      const state = systemctl(['is-enabled', AGENTWORLD_SERVICE])
      return state === 'enabled' ? true : state === 'disabled' ? false : null
    })(),
    active: systemctl(['is-active', AGENTWORLD_SERVICE]) === 'active',
    port: AGENTWORLD_PORT,
    portOwner: portOwner(),
    artifactPresent: fs.existsSync(AGENTWORLD_ARTIFACT),
    // Hashing a 35B artifact is intentionally an explicit start-time gate,
    // not a blocking status-read side effect.
    artifactSha256: null,
    artifactVerified: null,
    alias: AGENTWORLD_ALIAS,
    context: AGENTWORLD_CONTEXT,
    runtimeIdentity: null,
  }
}

async function waitForPort(
  expectedFree: boolean,
  timeoutMs = 30_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((portOwner() === null) === expectedFree) return true
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return (portOwner() === null) === expectedFree
}

async function stopManagedFleetOwner(): Promise<void> {
  const active = MANAGED_FLEET_SERVICES.filter(
    (service) => systemctl(['is-active', service]) === 'active',
  )
  for (const service of active) {
    if (!systemctlCommand(['stop', service]))
      throw new Error(`Unable to stop managed model service ${service}`)
  }
  if (active.length > 0 && !(await waitForPort(true)))
    throw new Error(
      'Managed model service did not release port 8080 within 30 seconds',
    )
}

export async function startWorldModel(
  options: { switchExisting?: boolean } = {},
): Promise<WorldModelStatus> {
  const current = getWorldModelStatus()
  const verifiedArtifactSha = current.artifactPresent ? artifactSha256() : null
  if (verifiedArtifactSha !== AGENTWORLD_SHA256)
    throw new Error(
      'AgentWorld artifact is missing or failed SHA-256 verification',
    )
  if (current.portOwner && !current.active) {
    if (!options.switchExisting)
      throw new Error(
        `Port 8080 is owned by ${current.portOwner}; refusing to stop an unmanaged process`,
      )
    await stopManagedFleetOwner()
    if (portOwner() !== null)
      throw new Error(`Port 8080 is still owned by ${current.portOwner}`)
  }
  if (!current.portOwner) {
    if (!systemctlCommand(['start', AGENTWORLD_SERVICE]))
      throw new Error('Unable to start AgentWorld systemd service')
    await waitForPort(false)
  }
  const identity = await readWorldModelIdentity()
  if (
    !identity ||
    identity.alias !== AGENTWORLD_ALIAS ||
    identity.context !== AGENTWORLD_CONTEXT
  ) {
    systemctlCommand(['stop', AGENTWORLD_SERVICE])
    throw new Error(
      'AgentWorld started without the expected model alias/context identity',
    )
  }
  return {
    ...getWorldModelStatus(),
    artifactSha256: verifiedArtifactSha,
    artifactVerified: true,
    active: true,
    runtimeIdentity: identity,
  }
}

export async function stopWorldModel(): Promise<WorldModelStatus> {
  if (!systemctlCommand(['stop', AGENTWORLD_SERVICE]))
    throw new Error('Unable to stop AgentWorld systemd service')
  await waitForPort(true)
  return getWorldModelStatus()
}

function bounded(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, MAX_FIELD_CHARS) : ''
}

export function validateSimulationRequest(
  value: unknown,
): WorldModelSimulationRequest {
  const input = asObject(value)
  const request: WorldModelSimulationRequest = {
    domain: bounded(input.domain),
    environment_state: bounded(input.environment_state),
    history: bounded(input.history),
    proposed_action: bounded(input.proposed_action),
    constraints: bounded(input.constraints),
    prediction_depth: bounded(input.prediction_depth) || 'next_observation',
  }
  if (!request.domain || !request.environment_state || !request.proposed_action)
    throw new Error(
      'domain, environment_state, and proposed_action are required',
    )
  if (JSON.stringify(request).length > MAX_TOTAL_CHARS)
    throw new Error('simulation capsule is too large')
  return request
}

export async function simulateWorldModel(
  request: WorldModelSimulationRequest,
): Promise<WorldModelSimulationResponse> {
  const identity = await readWorldModelIdentity()
  if (!identity) throw new Error('AgentWorld is not active on 127.0.0.1:8080')
  if (
    identity.alias !== AGENTWORLD_ALIAS ||
    identity.context !== AGENTWORLD_CONTEXT
  )
    throw new Error(
      'Port 8080 is occupied by a model with an unexpected identity',
    )

  const capsule = JSON.stringify(request, null, 2)
  const response = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(120_000),
    body: JSON.stringify({
      model: AGENTWORLD_ALIAS,
      temperature: 0.1,
      max_tokens: 512,
      response_format: { type: 'json_object' },
      chat_template_kwargs: { enable_thinking: false },
      messages: [
        {
          role: 'system',
          content:
            'You are ValKhana world_model.simulate. Predict consequences only; do not execute actions. Return JSON with predicted_observation (string), predicted_side_effects (string array), and uncertainties (string array). Use only the bounded state capsule.',
        },
        { role: 'user', content: `Bounded state capsule:\n${capsule}` },
      ],
    }),
  })
  if (!response.ok)
    throw new Error(`AgentWorld completion failed with HTTP ${response.status}`)
  const payload = asObject(await response.json())
  const choices = Array.isArray(payload.choices) ? payload.choices : []
  const message = asObject(asObject(choices[0]).message)
  let parsed: Record<string, unknown>
  try {
    parsed = asObject(
      JSON.parse(typeof message.content === 'string' ? message.content : ''),
    )
  } catch {
    throw new Error('AgentWorld returned non-JSON simulation output')
  }
  return {
    predicted_observation: bounded(parsed.predicted_observation),
    predicted_side_effects: Array.isArray(parsed.predicted_side_effects)
      ? parsed.predicted_side_effects
          .filter((v): v is string => typeof v === 'string')
          .slice(0, 64)
      : [],
    uncertainties: Array.isArray(parsed.uncertainties)
      ? parsed.uncertainties
          .filter((v): v is string => typeof v === 'string')
          .slice(0, 64)
      : [],
  }
}
