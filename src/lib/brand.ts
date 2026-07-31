/**
 * Centralized branding constants. Created per the original build plan
 * (hermes-atlas-build-plan.md, Rebranding section) - the earlier rebrand
 * pass (0eef7714) hand-edited ~40 hardcoded 'Valkhana' string literals
 * across files instead of centralizing here, exactly the scattered
 * find-and-replace pattern the plan warned against (citing this repo's
 * own prior rebrand incident, which needed a follow-up fix commit after
 * breaking things).
 *
 * Scope: redirects the app's own primary identity surfaces (splash/login,
 * page title, sidebar/dashboard headers, settings). Does NOT touch:
 * - NousResearch/hermes-agent's own CLI internals (hermes, HERMES_HOME) -
 *   a hard boundary per the build plan, not a gap
 * - The HermesWorld game sub-brand's dialogue/lore text - a distinct
 *   in-universe concept, not this app's own identity (already excluded
 *   from the original rebrand pass for the same reason)
 * - Test fixtures asserting exact label strings - those are fine as
 *   literals, re-deriving them from this file adds no safety value
 */
export const APP_NAME = 'Valkhana'
export const APP_TAGLINE = 'AI OS Workspace'
export const APP_DESCRIPTION =
  'Valkhana - desktop workspace for Hermes Agent: chat, orchestration, and multi-agent coding pipelines'
