import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import {
  simulateWorldModel,
  validateSimulationRequest,
} from '../../../server/world-model'

export const Route = createFileRoute('/api/world-model/simulate')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isAuthenticated(request))
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        try {
          const input = validateSimulationRequest(await request.json())
          return json({
            ok: true,
            capability: 'world_model.simulate',
            prediction: await simulateWorldModel(input),
          })
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message
              : 'World model simulation failed'
          const status =
            message.includes('required') || message.includes('too large')
              ? 400
              : 503
          return json({ ok: false, error: message }, { status })
        }
      },
    },
  },
})
