import { contrastRatio, mixHex, mixHexRgba, pickForeground, relativeLuminance } from '@/lib/color'
import type { WebsiteEmbedThemeOverrides } from '@/lib/embed-widget'
import type { WebsiteEmbedThemeSettings } from '@/lib/api'

const MIN_LEGIBLE_CONTRAST = 3
const ensureLegibleForeground = (background: string, foreground: string) =>
  contrastRatio(background, foreground) >= MIN_LEGIBLE_CONTRAST ? foreground : pickForeground(background)

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
