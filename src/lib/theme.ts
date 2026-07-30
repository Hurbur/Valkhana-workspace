export type ThemeId =
  | 'claude-nous'
  | 'claude-nous-light'
  | 'matrix'
  | 'matrix-light'
  | 'claude-official'
  | 'claude-official-light'
  | 'claude-classic'
  | 'claude-classic-light'
  | 'claude-slate'
  | 'claude-slate-light'
  | 'scifi'
  | 'scifi-light'
  | 'atlas-blue'
  | 'atlas-blue-light'
  | 'purple'
  | 'purple-light'
  | 'red-gold'
  | 'red-gold-light'
  | 'pink'
  | 'pink-light'

export const THEMES: Array<{
  id: ThemeId
  label: string
  description: string
  icon: string
}> = [
  {
    id: 'claude-nous',
    label: 'Nous',
    description: 'Deep teal background, cream accent — matches Nous Research chrome',
    icon: '◱',
  },
  {
    id: 'claude-nous-light',
    label: 'Nous Light',
    description: 'Cold paper white with restrained cobalt framing',
    icon: '◲',
  },
  {
    id: 'matrix',
    label: 'Matrix',
    description: 'Black glass terminal field with phosphor green signal glow',
    icon: '▣',
  },
  {
    id: 'matrix-light',
    label: 'Matrix Light',
    description: 'White terminal paper with green signal accents',
    icon: '▣',
  },
  {
    id: 'claude-official',
    label: 'Hermes',
    description: 'Navy and indigo flagship theme',
    icon: '⚕',
  },
  {
    id: 'claude-official-light',
    label: 'Hermes Light',
    description: 'Editorial paper white with muted cobalt accents',
    icon: '⚕',
  },
  {
    id: 'claude-classic',
    label: 'Bronze',
    description: 'Bronze accents on dark charcoal',
    icon: '🔶',
  },
  {
    id: 'claude-classic-light',
    label: 'Bronze Light',
    description: 'Warm parchment with bronze accents',
    icon: '🔶',
  },
  {
    id: 'claude-slate',
    label: 'Slate',
    description: 'Cool blue developer theme',
    icon: '🔷',
  },
  {
    id: 'claude-slate-light',
    label: 'Slate Light',
    description: 'GitHub-light palette with blue accents',
    icon: '🔷',
  },
  {
    id: 'scifi',
    label: 'SciFi',
    description: 'Cyberpunk HUD — deep navy, cyan neon, orange highlights',
    icon: '🌌',
  },
  {
    id: 'scifi-light',
    label: 'SciFi Light',
    description: 'Cold steel and teal — cyberpunk interface in daylight',
    icon: '🌌',
  },
  {
    id: 'atlas-blue',
    label: 'Atlas Blue',
    description: 'Deep navy command center with cyan signal glow',
    icon: '🔵',
  },
  {
    id: 'atlas-blue-light',
    label: 'Atlas Blue Light',
    description: 'Clean white command center with cobalt-blue accents',
    icon: '🔵',
  },
  {
    id: 'purple',
    label: 'Purple',
    description: 'Dark violet workspace with luminous lavender accents',
    icon: '🟣',
  },
  {
    id: 'purple-light',
    label: 'Purple Light',
    description: 'Soft lavender workspace with violet accents',
    icon: '🟣',
  },
  {
    id: 'red-gold',
    label: 'Red Gold',
    description: 'Dark ember workspace with warm gold signal accents',
    icon: '🟠',
  },
  {
    id: 'red-gold-light',
    label: 'Red Gold Light',
    description: 'Warm parchment workspace with amber-gold accents',
    icon: '🟠',
  },
  {
    id: 'pink',
    label: 'Pink',
    description: 'Dark rose workspace with vivid pink signal accents',
    icon: '🩷',
  },
  {
    id: 'pink-light',
    label: 'Pink Light',
    description: 'Soft rose workspace with pink accents',
    icon: '🩷',
  },
]

const STORAGE_KEY = 'claude-theme'
const DEFAULT_THEME: ThemeId = 'claude-nous'
const THEME_SET = new Set<ThemeId>(THEMES.map((theme) => theme.id))

const LIGHT_THEME_MAP: Record<
  Exclude<ThemeId, `${string}-light`>,
  Extract<ThemeId, `${string}-light`>
> = {
  'claude-nous': 'claude-nous-light',
  matrix: 'matrix-light',
  'claude-official': 'claude-official-light',
  'claude-classic': 'claude-classic-light',
  'claude-slate': 'claude-slate-light',
  scifi: 'scifi-light',
  'atlas-blue': 'atlas-blue-light',
  purple: 'purple-light',
  'red-gold': 'red-gold-light',
  pink: 'pink-light',
}

const DARK_THEME_MAP: Record<
  Extract<ThemeId, `${string}-light`>,
  Exclude<ThemeId, `${string}-light`>
> = {
  'claude-nous-light': 'claude-nous',
  'matrix-light': 'matrix',
  'claude-official-light': 'claude-official',
  'claude-classic-light': 'claude-classic',
  'claude-slate-light': 'claude-slate',
  'scifi-light': 'scifi',
  'atlas-blue-light': 'atlas-blue',
  'purple-light': 'purple',
  'red-gold-light': 'red-gold',
  'pink-light': 'pink',
}

const LIGHT_THEMES = new Set<ThemeId>([
  'claude-nous-light',
  'matrix-light',
  'claude-official-light',
  'claude-classic-light',
  'claude-slate-light',
  'scifi-light',
  'atlas-blue-light',
  'purple-light',
  'red-gold-light',
  'pink-light',
])

export function isValidTheme(
  value: string | null | undefined,
): value is ThemeId {
  return typeof value === 'string' && THEME_SET.has(value as ThemeId)
}

export function isDarkTheme(theme: ThemeId): boolean {
  return !LIGHT_THEMES.has(theme)
}

export function getThemeVariant(
  theme: ThemeId,
  mode: 'light' | 'dark',
): ThemeId {
  if (mode === 'light') {
    return isDarkTheme(theme)
      ? LIGHT_THEME_MAP[theme as keyof typeof LIGHT_THEME_MAP]
      : theme
  }

  return isDarkTheme(theme)
    ? theme
    : DARK_THEME_MAP[theme as keyof typeof DARK_THEME_MAP]
}

export function getTheme(): ThemeId {
  if (typeof window === 'undefined') return DEFAULT_THEME
  const stored = localStorage.getItem(STORAGE_KEY)
  return isValidTheme(stored) ? stored : DEFAULT_THEME
}

export function setTheme(theme: ThemeId): void {
  const root = document.documentElement
  root.setAttribute('data-theme', theme)
  root.classList.remove('light', 'dark', 'system')
  const nextMode = isDarkTheme(theme) ? 'dark' : 'light'
  root.classList.add(nextMode)
  root.style.setProperty('color-scheme', nextMode)
  localStorage.setItem(STORAGE_KEY, theme)
}
