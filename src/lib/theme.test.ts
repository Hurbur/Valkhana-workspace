import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { getThemeVariant, THEMES, isValidTheme } from './theme'

describe('Atlas theme registration', () => {
  it('registers every planned Atlas dark and light theme', () => {
    const themeIds = THEMES.map((theme) => theme.id)

    expect(themeIds).toEqual(
      expect.arrayContaining([
        'atlas-blue',
        'atlas-blue-light',
        'purple',
        'purple-light',
        'red-gold',
        'red-gold-light',
        'pink',
        'pink-light',
      ]),
    )

    expect(isValidTheme('atlas-blue')).toBe(true)
    expect(isValidTheme('pink-light')).toBe(true)
  })

  it('switches every Atlas palette between its dark and light variants', () => {
    const pairs = [
      ['atlas-blue', 'atlas-blue-light'],
      ['purple', 'purple-light'],
      ['red-gold', 'red-gold-light'],
      ['pink', 'pink-light'],
    ] as const

    for (const [dark, light] of pairs) {
      expect(getThemeVariant(dark, 'light')).toBe(light)
      expect(getThemeVariant(light, 'dark')).toBe(dark)
    }
  })

  it('makes every Atlas palette selectable from the Theme settings picker', () => {
    const settingsDialog = readFileSync(
      new URL('../components/settings-dialog/settings-dialog.tsx', import.meta.url),
      'utf8',
    )
    const families = settingsDialog.match(
      /const ENTERPRISE_THEME_FAMILIES: Array<ThemeId> = \[([\s\S]*?)\]/,
    )?.[1]

    expect(families).toContain("'atlas-blue'")
    expect(families).toContain("'purple'")
    expect(families).toContain("'red-gold'")
    expect(families).toContain("'pink'")
  })
})
