import { contrastRatio, mixHex, mixHexRgba, parseHex, pickForeground, relativeLuminance, shadeToContrast } from '@/lib/color'
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

/** WCAG 1.4.11: the glyph of a control reads at 3:1 against what it sits on. */
const MIN_CONTROL_CONTRAST = 3
/**
 * How far a quiet icon fades from the field's foreground toward the field, firmer than the theme's
 * muted foreground, so it never reads as the glyph of a disabled Send, which is drawn in that.
 */
const QUIET_ICON_FADE = 0.3

/**
 * The colour of a quiet icon button's glyph (the paperclip, Talk) on the composer field: the field's
 * foreground faded part of the way, and never fainter than 3:1. A theme made of CSS variables, as the
 * dashboard's is, names its muted foreground, since no contrast can be computed from a variable.
 */
export const quietIconForeground = (theme: { inputBackground: string; inputForeground: string; mutedForeground: string }): string => {
  if (!parseHex(theme.inputBackground) || !parseHex(theme.inputForeground)) {
    return theme.mutedForeground
  }
  const faded = mixHex(theme.inputForeground, theme.inputBackground, QUIET_ICON_FADE)
  return ensureLegibleForeground(theme.inputBackground, faded, MIN_CONTROL_CONTRAST)
}

/**
 * The colour of a link in an assistant answer: the theme's accent, shaded just far enough to read
 * as text on the bubble, so a light brand colour keeps its hue instead of turning into body text.
 * The accent as given when it is not a hex colour, since no contrast can be computed from it.
 */
export const messageLinkForeground = (theme: { accent: string; assistantBubbleBackground: string }): string =>
  shadeToContrast(theme.accent, theme.assistantBubbleBackground, MIN_TEXT_CONTRAST)

/** How far a disabled Send's glyph fades into its fill, below the quiet icons' 3:1 floor. */
const DISABLED_GLYPH_FADE = 0.5

/**
 * The glyph of a disabled Send: the muted foreground faded halfway into the muted fill it sits on,
 * so an inactive control never reads firmer than the live paperclip and Talk icons beside it.
 * WCAG 1.4.11 exempts inactive controls. A theme made of CSS variables names its muted foreground.
 */
export const disabledSendForeground = (theme: { mutedBackground: string; mutedForeground: string }): string =>
  mixHex(theme.mutedForeground, theme.mutedBackground, DISABLED_GLYPH_FADE)

export const deriveThemeOverridesFromModel = (theme?: WebsiteEmbedThemeSettings | null): WebsiteEmbedThemeOverrides | null => {
  if (!theme) {
    return null
  }
  const surface = theme.surface
  const brand = theme.brand
  const text = ensureLegibleForeground(surface, theme.text)
  const brandText = ensureLegibleForeground(brand, theme.brandText)

  // Muted text (citation markers, the Sources row, timestamps) sits on the panel, the bubble and the
  // muted surface. The muted surface is the nearest of them to the text colour, and the muted text is
  // shaded toward the text's own side, so reading there reads on all three. It stops at the body
  // text's own contrast so it never outweighs body text that only just reads.
  const mutedBackground = mixHex(surface, text, 0.06)
  const mutedForeground = shadeToContrast(
    mixHex(text, surface, 0.45),
    mutedBackground,
    Math.min(MIN_TEXT_CONTRAST, contrastRatio(mutedBackground, text)),
  )

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
    mutedBackground,
    mutedForeground,
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
