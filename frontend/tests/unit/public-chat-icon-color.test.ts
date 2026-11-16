import { describe, expect, it } from 'vitest'

import { contrastRatio } from '@/lib/color'
import { getWebsiteEmbedTheme } from '@/lib/embed-widget'
import { quietIconForeground } from '@/lib/public-chat-theme'

// A control's glyph must read at 3:1 on what it sits on (WCAG 1.4.11).
const MIN_CONTROL_CONTRAST = 3

const iconOn = (field: string, foreground: string, mutedForeground = '#64748b') =>
  quietIconForeground({ inputBackground: field, inputForeground: foreground, mutedForeground })

describe('the colour of a quiet icon button on the composer field', () => {
  it.each([
    ['#555555', '#ffffff'],
    ['#94a3b8', '#1e293b'],
    // Foregrounds that are themselves faint, which fading would push under the bar.
    ['#999999', '#ffffff'],
    ['#6b7280', '#1e293b'],
    ['#f1f5f9', '#ffffff'],
    ['#0f172a', '#0f172a'],
  ])('reads at 3:1 or better for a %s foreground on %s', (foreground, field) => {
    expect(contrastRatio(field, iconOn(field, foreground))).toBeGreaterThanOrEqual(MIN_CONTROL_CONTRAST)
  })

  it('reads at 3:1 or better on the default theme, and is not the muted foreground a disabled Send is drawn in', () => {
    const theme = getWebsiteEmbedTheme()
    const color = quietIconForeground(theme)
    expect(contrastRatio(theme.inputBackground, color)).toBeGreaterThanOrEqual(MIN_CONTROL_CONTRAST)
    expect(color).not.toBe(theme.mutedForeground)
    expect(contrastRatio(theme.inputBackground, color)).toBeGreaterThan(contrastRatio(theme.inputBackground, theme.mutedForeground))
  })

  it('stays a softened foreground rather than the foreground itself when it reads well enough', () => {
    const color = iconOn('#ffffff', '#0f172a')
    expect(color).not.toBe('#0f172a')
    expect(contrastRatio('#ffffff', color)).toBeGreaterThanOrEqual(MIN_CONTROL_CONTRAST)
  })

  it('names the dashboard theme\'s own muted foreground when the colours are CSS variables', () => {
    expect(quietIconForeground({ inputBackground: 'var(--background)', inputForeground: 'var(--foreground)', mutedForeground: 'var(--muted-foreground)' }))
      .toBe('var(--muted-foreground)')
  })
})
