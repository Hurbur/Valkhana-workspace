import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'

export const SWARM_DISPATCH_AUTHORITY_MESSAGE =
  'Direct Workspace Swarm dispatch is disabled. Submit work through ValKhana Core / Hermes; local worker processes, tmux sessions, runtime files, and mission stores are not execution authorities.'

export const Route = createFileRoute('/api/swarm-dispatch')({
  server: { handlers: { POST: async ({ request }) => {
    if (!isAuthenticated(request)) return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
    return json({ ok: false, error: SWARM_DISPATCH_AUTHORITY_MESSAGE, authority: 'valkhana-core/hermes' }, { status: 409 })
  } } },
})
