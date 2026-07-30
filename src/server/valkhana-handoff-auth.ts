import { timingSafeEqual } from 'node:crypto'
import {
  isAuthenticated,
  isPasswordProtectionEnabled,
} from './auth-middleware'

export class ValkhanaHandoffAuthorizationError extends Error {
  constructor(
    message: string,
    public readonly status: 401 | 503,
  ) {
    super(message)
    this.name = 'ValkhanaHandoffAuthorizationError'
  }
}

/**
 * Authorizes the non-browser Brain writer. The token is distinct from model
 * credentials and is read only by this server process from its environment.
 */
export function assertBrainWriterAuthorized(request: Request): void {
  const configured = process.env.HERMES_HANDOFF_BRAIN_TOKEN || ''
  if (!configured) {
    throw new ValkhanaHandoffAuthorizationError(
      'Brain handoff writer is not configured',
      503,
    )
  }
  const authorization = request.headers.get('authorization') || ''
  const supplied = authorization.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length)
    : ''
  const expectedBytes = Buffer.from(configured, 'utf8')
  const suppliedBytes = Buffer.from(supplied, 'utf8')
  if (
    !supplied ||
    suppliedBytes.length !== expectedBytes.length ||
    !timingSafeEqual(suppliedBytes, expectedBytes)
  ) {
    throw new ValkhanaHandoffAuthorizationError('Unauthorized Brain writer', 401)
  }
}

/**
 * Browser writes are allowed only after the operator explicitly configures
 * Workspace password protection and the request carries its valid session.
 * A Tailscale network boundary alone is not sufficient authorization to alter
 * profile state.
 */
export function assertTerminalBrowserMutationAuthorized(request: Request): void {
  if (!isPasswordProtectionEnabled()) {
    throw new ValkhanaHandoffAuthorizationError(
      'Handoff mutations require Workspace password authentication',
      503,
    )
  }
  if (!isAuthenticated(request)) {
    throw new ValkhanaHandoffAuthorizationError('Unauthorized terminal writer', 401)
  }
}
