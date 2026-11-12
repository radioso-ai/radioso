import { contrastRatio, mixHex, mixHexRgba, pickForeground, relativeLuminance } from '@/lib/color'
import type { WebsiteEmbedThemeOverrides } from '@/lib/embed-widget'
import type { WebsiteEmbedThemeSettings } from '@/lib/api'

const MIN_LEGIBLE_CONTRAST = 3
/** WCAG's bar for body text, which a short notice is. */
const MIN_TEXT_CONTRAST = 4.5

/**
 * The foreground when it reads on the background at `minContrast`; else the light or dark that
 * reads better, and pure white or black when neither of those reaches `minContrast` (a mid-tone
 * background), which one of the two always does at 4.5:1.
 */
export const ensureLegibleForeground = (background: string, foreground: string, minContrast = MIN_LEGIBLE_CONTRAST) => {
  if (contrastRatio(background, foreground) >= minContrast) {
    return foreground
  }
  const fallback = pickForeground(background)
  return contrastRatio(background, fallback) >= minContrast ? fallback : pickForeground(background, { light: '#ffffff', dark: '#000000' })
}

const ERROR_ON_LIGHT = '#b91c1c'
const ERROR_ON_DARK = '#fca5a5'

/** The colour of an error line or mark on `background`: red where red reads at 4.5:1, else black or white. */
export const errorForeground = (background: string): string =>
  ensureLegibleForeground(background, relativeLuminance(background) < 0.5 ? ERROR_ON_DARK : ERROR_ON_LIGHT, MIN_TEXT_CONTRAST)

export const deriveThemeOverridesFromModel = (theme?: WebsiteEmbedThemeSettings | null): WebsiteEmbedThemeOverrides | null => {
  if (!theme) {
    return null
  }
  const surface = theme.surface
  const brand = theme.brand
  const text = ensureLegibleForeground(surface, theme.text)
  const brandText = ensureLegibleForeground(brand, theme.brandText)

  const isSurfaceDark = relativeLuminance(surface) < 0.5
  const shadowSurface = isSurfaceDark
    ? '0 24px 60px rgba(0, 0, 0, 0.55)'
    : '0 24px 60px rgba(15, 23, 42, 0.28)'
  const shadowBrand = relativeLuminance(brand) < 0.5
    ? '0 18px 40px rgba(0, 0, 0, 0.45)'
    : '0 18px 40px rgba(15, 23, 42, 0.24)'

  return {
    launcherBackground: brand,
    launcherForeground: brandText,
    launcherBorder: mixHexRgba(brand, brandText, 0.16, 0.5),
    launcherShadow: shadowBrand,
    panelBackground: surface,
    panelForeground: text,
    panelBorder: mixHexRgba(surface, text, 0.18, 0.55),
    panelShadow: shadowSurface,
    accent: brand,
    accentForeground: brandText,
    mutedBackground: mixHex(surface, text, 0.06),
    mutedForeground: mixHex(text, surface, 0.45),
    inputBackground: surface,
    inputForeground: text,
    inputBorder: mixHex(surface, text, 0.2),
    inputPlaceholder: mixHex(text, surface, 0.5),
    assistantBubbleBackground: mixHex(surface, text, 0.04),
    assistantBubbleForeground: text,
    userBubbleBackground: brand,
    userBubbleForeground: brandText,
  }
}
