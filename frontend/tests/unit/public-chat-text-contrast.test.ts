import { describe, expect, it } from 'vitest'

import { contrastRatio, parseHex, relativeLuminance } from '@/lib/color'
import { getWebsiteEmbedTheme } from '@/lib/embed-widget'
import { deriveThemeOverridesFromModel, disabledSendForeground, messageLinkForeground, quietIconForeground } from '@/lib/public-chat-theme'

// WCAG 1.4.3: body-size text reads at 4.5:1 on what it sits on.
const MIN_TEXT_CONTRAST = 4.5

const linkOn = (bubble: string, accent: string) =>
  messageLinkForeground({ accent, assistantBubbleBackground: bubble })

const derived = (surface: string, text: string) =>
  getWebsiteEmbedTheme(deriveThemeOverridesFromModel({ surface, text, brand: '#2563eb', brandText: '#ffffff' }))

describe('the colour of a link in an assistant answer', () => {
  it.each([
    ['#38bdf8', '#f5f6f6'],
    ['#fbbf24', '#ffffff'],
    ['#a3e635', '#f8fafc'],
    ['#1e3a8a', '#111827'],
    ['#7c3aed', '#1f2937'],
    // A mid-tone bubble, where neither pole is far away.
    ['#808080', '#767676'],
  ])('reads at 4.5:1 or better for a %s brand on a %s bubble', (accent, bubble) => {
    expect(contrastRatio(bubble, linkOn(bubble, accent))).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST)
  })

  it('is the brand itself when the brand already reads', () => {
    expect(linkOn('#ffffff', '#1d4ed8')).toBe('#1d4ed8')
  })

  it('keeps the brand hue rather than falling back to the body text colour', () => {
    const link = parseHex(linkOn('#f5f6f6', '#38bdf8'))!
    expect(link.b).toBeGreaterThan(link.r + 40)
  })

  it('is the accent unchanged when the theme names colours no contrast can be computed from', () => {
    expect(linkOn('var(--muted)', 'var(--primary)')).toBe('var(--primary)')
    expect(linkOn('rgb(17, 24, 39)', 'rgb(15, 118, 110)')).toBe('rgb(15, 118, 110)')
  })

  it('reads at 4.5:1 or better on the default embed theme', () => {
    const theme = getWebsiteEmbedTheme()
    expect(contrastRatio(theme.assistantBubbleBackground, messageLinkForeground(theme))).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST)
  })
})

describe('the muted text colour derived from an operator theme', () => {
  it.each([
    ['#ffffff', '#0f172a'],
    ['#ffffff', '#333333'],
    ['#fdf6e3', '#3b3b3b'],
    ['#0f172a', '#f8fafc'],
    ['#1f2937', '#9ca3af'],
    // Mid-tone surfaces, where black and white stand about as far from the surface.
    ['#dc2626', '#ffffff'],
    ['#6b7280', '#ffffff'],
    ['#db2777', '#ffffff'],
  ])('reads at 4.5:1, or as well as the body text where that reads less, on the bubble, panel and muted surface for a %s surface with %s text', (surface, text) => {
    const theme = derived(surface, text)
    for (const background of [theme.assistantBubbleBackground, theme.panelBackground, theme.mutedBackground]) {
      const bar = Math.min(MIN_TEXT_CONTRAST, contrastRatio(background, theme.panelForeground))
      expect(contrastRatio(background, theme.mutedForeground)).toBeGreaterThanOrEqual(bar - 0.05)
    }
  })

  it.each([
    ['#dc2626', '#ffffff'],
    ['#6b7280', '#ffffff'],
    ['#ffffff', '#0f172a'],
  ])('sits on the same side of a %s surface as its %s text', (surface, text) => {
    const theme = derived(surface, text)
    const textIsLighter = relativeLuminance(theme.panelForeground) > relativeLuminance(theme.panelBackground)
    expect(relativeLuminance(theme.mutedForeground) > relativeLuminance(theme.panelBackground)).toBe(textIsLighter)
  })

  it.each([
    ['#ffffff', '#0f172a'],
    // Body text that only just reads, which muted text must not outweigh.
    ['#ffffff', '#949494'],
    ['#ffffff', '#767676'],
  ])('is never firmer than the body text on a %s surface with %s text', (surface, text) => {
    const theme = derived(surface, text)
    expect(contrastRatio(theme.mutedBackground, theme.mutedForeground)).toBeLessThanOrEqual(contrastRatio(theme.mutedBackground, theme.panelForeground))
  })
})

describe('the glyph of a disabled Send', () => {
  it.each([
    ['#ffffff', '#0f172a'],
    ['#1f2937', '#9ca3af'],
    ['#2563eb', '#ffffff'],
    ['#0f766e', '#ffffff'],
    ['#dc2626', '#ffffff'],
  ])('reads fainter than the live quiet icons on a %s surface with %s text', (surface, text) => {
    const theme = derived(surface, text)
    expect(contrastRatio(theme.mutedBackground, disabledSendForeground(theme)))
      .toBeLessThan(contrastRatio(theme.inputBackground, quietIconForeground(theme)))
  })

  it('reads fainter than the live quiet icons on the default theme', () => {
    const theme = getWebsiteEmbedTheme()
    expect(contrastRatio(theme.mutedBackground, disabledSendForeground(theme)))
      .toBeLessThan(contrastRatio(theme.inputBackground, quietIconForeground(theme)))
  })

  it('names the theme\'s own muted foreground when the colours are CSS variables', () => {
    expect(disabledSendForeground({ mutedBackground: 'var(--muted)', mutedForeground: 'var(--muted-foreground)' })).toBe('var(--muted-foreground)')
  })
})
