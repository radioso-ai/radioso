import type { WebsiteEmbedThemeSettings } from '@/lib/api'
import { pickForeground } from '@/lib/color'

export const DEFAULT_ASSISTANT_THEME: WebsiteEmbedThemeSettings = {
  brand: '#0f172a',
  brandText: '#f8fafc',
  surface: '#ffffff',
  text: '#0f172a',
}

export const LIGHT_SURFACE = { surface: '#ffffff', text: '#0f172a' } as const
export const DARK_SURFACE = { surface: '#0f172a', text: '#f8fafc' } as const

export type SurfaceMode = 'light' | 'dark' | 'custom'

export const ADVANCED_THEME_FIELDS: { key: 'brandText' | 'text'; label: string; hint: string }[] = [
  { key: 'brandText', label: 'Text on brand color', hint: 'Auto-picked for contrast. Override if your brand needs a custom tone.' },
  { key: 'text', label: 'Text on chat background', hint: 'Auto-picked for contrast. Override for a custom body-text color.' },
]

export const getSurfaceMode = (theme: WebsiteEmbedThemeSettings): SurfaceMode => {
  const surface = theme.surface.toLowerCase()
  const text = theme.text.toLowerCase()
  if (surface === LIGHT_SURFACE.surface && text === LIGHT_SURFACE.text) return 'light'
  if (surface === DARK_SURFACE.surface && text === DARK_SURFACE.text) return 'dark'
  return 'custom'
}

export const applyBrand = (
  current: WebsiteEmbedThemeSettings,
  value: string,
): WebsiteEmbedThemeSettings => ({
  ...current,
  brand: value,
  brandText: pickForeground(value),
})

export const applySurface = (
  current: WebsiteEmbedThemeSettings,
  value: string,
): WebsiteEmbedThemeSettings => ({
  ...current,
  surface: value,
  text: pickForeground(value),
})

export const applySurfaceMode = (
  current: WebsiteEmbedThemeSettings,
  mode: 'light' | 'dark',
): WebsiteEmbedThemeSettings => ({
  ...current,
  ...(mode === 'light' ? LIGHT_SURFACE : DARK_SURFACE),
})
