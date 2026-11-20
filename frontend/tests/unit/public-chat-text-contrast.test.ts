import { describe, expect, it } from 'vitest'

import { contrastRatio, parseHex } from '@/lib/color'
import { getWebsiteEmbedTheme } from '@/lib/embed-widget'
import { deriveThemeOverridesFromModel, messageLinkForeground } from '@/lib/public-chat-theme'

// WCAG 1.4.3: body-size text reads at 4.5:1 on what it sits on.
const MIN_TEXT_CONTRAST = 4.5

const linkOn = (bubble: string, accent: string) =>
  messageLinkForeground({ accent, assistantBubbleBackground: bubble })

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
    expect(contrastRatio(bubble, linkOn(bubble, accent)!)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST)
  })

  it('is the brand itself when the brand already reads', () => {
    expect(linkOn('#ffffff', '#1d4ed8')).toBe('#1d4ed8')
  })

  it('keeps the brand hue rather than falling back to the body text colour', () => {
    const link = parseHex(linkOn('#f5f6f6', '#38bdf8')!)!
    expect(link.b).toBeGreaterThan(link.r + 40)
  })

  it('leaves the colour to the stylesheet when the theme names CSS variables', () => {
    expect(linkOn('var(--muted)', 'var(--primary)')).toBeUndefined()
  })

  it('reads at 4.5:1 or better on the default embed theme', () => {
    const theme = getWebsiteEmbedTheme()
    expect(contrastRatio(theme.assistantBubbleBackground, messageLinkForeground(theme)!)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST)
  })
})

describe('the muted text colour derived from an operator theme', () => {
  it.each([
    ['#ffffff', '#0f172a'],
    ['#ffffff', '#333333'],
    ['#fdf6e3', '#3b3b3b'],
    ['#0f172a', '#f8fafc'],
    ['#1f2937', '#9ca3af'],
  ])('reads at 4.5:1 or better on the bubble and the muted surface for a %s surface with %s text', (surface, text) => {
    const theme = deriveThemeOverridesFromModel({ surface, text, brand: '#2563eb', brandText: '#ffffff' })!
    expect(contrastRatio(theme.assistantBubbleBackground!, theme.mutedForeground!)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST)
    expect(contrastRatio(theme.mutedBackground!, theme.mutedForeground!)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST)
  })

  it('stays softer than the body text', () => {
    const theme = deriveThemeOverridesFromModel({ surface: '#ffffff', text: '#0f172a', brand: '#2563eb', brandText: '#ffffff' })!
    expect(contrastRatio('#ffffff', theme.mutedForeground!)).toBeLessThan(contrastRatio('#ffffff', '#0f172a'))
  })
})
