/**
 * Global Vitest setup — keeps the test process hermetic from the operator's
 * real .env secrets.
 *
 * Vitest's own env loading (independent of this repo's manual loadEnv
 * bridge in vite.config.ts, which is itself skipped under VITEST) still
 * populates process.env from the real local .env file. That meant tests
 * silently depended on whatever was actually configured for this
 * deployment - e.g. after HERMES_PASSWORD was set for the first time,
 * src/routes/api/mcp/-presets.test.ts started getting real 401s from
 * isAuthenticated() instead of the unauthenticated-by-default behavior it
 * was written against, with no change to the test itself. A test's outcome
 * should never depend on what secrets happen to be configured on whichever
 * machine runs it.
 *
 * Delete known operator-secret-shaped vars here rather than trying to
 * enumerate every test file that needs one; any test that specifically
 * needs a value sets/mocks it itself (see auth-middleware.test.ts's
 * beforeEach/afterEach pattern).
 */
const OPERATOR_SECRET_ENV_KEYS = [
  'HERMES_PASSWORD',
  'HERMES_DASHBOARD_USERNAME',
  'HERMES_DASHBOARD_PASSWORD',
  'HERMES_HANDOFF_BRAIN_TOKEN',
  'HERMES_API_TOKEN',
  'CLAUDE_API_TOKEN',
  'CLAUDE_PASSWORD',
  'PLAYGROUND_ADMIN_TOKEN',
]

for (const key of OPERATOR_SECRET_ENV_KEYS) {
  delete process.env[key]
}
