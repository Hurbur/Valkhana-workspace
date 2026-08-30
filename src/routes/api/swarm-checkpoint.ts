import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'

export const SWARM_CHECKPOINT_AUTHORITY_MESSAGE =
  'Direct Workspace checkpoint writes are disabled. Worker lifecycle and review state must be recorded through ValKhana Core / Hermes.'

export const Route = createFileRoute('/api/swarm-checkpoint')({
  server: { handlers: { POST: async ({ request }) => {
    if (!isAuthenticated(request)) return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
    return json({ ok: false, error: SWARM_CHECKPOINT_AUTHORITY_MESSAGE, authority: 'valkhana-core/hermes' }, { status: 409 })
  } } },
})
