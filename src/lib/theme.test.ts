import { describe, expect, it } from 'vitest'
import { THEMES, isValidTheme } from './theme'

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
})
