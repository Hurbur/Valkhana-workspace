import { test, expect } from '@playwright/test'

// Backend-independent smoke tests for the Valkhana workspace UI.
//
// These run against the dev server with no Hermes gateway connected, so they
// cover the onboarding gate and the static app shell only.
//
// Run (from the repo root):
//   HERMES_WORKSPACE_AUTO_START_AGENT=false pnpm exec vite dev --host 127.0.0.1 --port 3000
//   HERMES_WORKSPACE_URL=http://127.0.0.1:3000 pnpm exec playwright test e2e/valkhana-smoke.spec.ts --project=chromium
//
// Negative check: setting VALKHANA_E2E_EXPECT_TITLE to a wrong value must make
// the first test fail, which proves the suite detects a broken expectation.

const BASE = process.env.HERMES_WORKSPACE_URL || 'http://localhost:3000'
const EXPECTED_TITLE = process.env.VALKHANA_E2E_EXPECT_TITLE || 'Valkhana'

test.describe('Valkhana smoke (no backend)', () => {
  test('first load shows the onboarding gate', async ({ page }) => {
    await page.goto(`${BASE}/`)
    await expect(page).toHaveTitle(EXPECTED_TITLE)
    await expect(
      page.getByRole('heading', { name: 'Welcome to Valkhana' }),
    ).toBeVisible({ timeout: 20_000 })
    await expect(page.getByRole('button', { name: 'Connect Backend' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Skip setup' })).toBeVisible()
  })

  test('skipping setup reveals the app shell and persists across reload', async ({ page }) => {
    await page.goto(`${BASE}/`)
    await page.getByRole('button', { name: 'Skip setup' }).click({ timeout: 20_000 })

    await expect(page.getByRole('heading', { name: 'Welcome to Valkhana' })).toHaveCount(0)
    await expect(page.getByText('New Session').first()).toBeVisible()

    await page.reload()
    await expect(page.getByText('New Session').first()).toBeVisible({ timeout: 20_000 })
    await expect(page.getByRole('button', { name: 'Skip setup' })).toHaveCount(0)
  })

  test('with no backend, the app surfaces connection guidance', async ({ page }) => {
    await page.goto(`${BASE}/`)
    await page.getByRole('button', { name: 'Skip setup' }).click({ timeout: 20_000 })

    // Never click "Auto-Start Hermes Agent Gateway": it launches a local process.
    await expect(page.getByText("Welcome! Let's connect your backend")).toBeVisible({ timeout: 20_000 })
    await page.getByRole('button', { name: 'Show manual setup' }).click()
    await expect(page.getByText('Set HERMES_API_URL to your backend base URL')).toBeVisible()
  })
})
