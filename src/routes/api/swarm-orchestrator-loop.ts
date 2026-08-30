import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'

export const SWARM_ORCHESTRATOR_AUTHORITY_MESSAGE =
  'The legacy Workspace orchestrator loop is disabled. Checkpoint mutation, continuation, review routing, and worker dispatch belong to ValKhana Core / Hermes.'

export const Route = createFileRoute('/api/swarm-orchestrator-loop')({
  server: { handlers: { POST: async ({ request }) => {
    if (!isAuthenticated(request)) return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
    return json({ ok: false, error: SWARM_ORCHESTRATOR_AUTHORITY_MESSAGE, authority: 'valkhana-core/hermes' }, { status: 409 })
  } } },
})
