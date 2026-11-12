import { describe, expect, it } from 'vitest'

import { contrastRatio } from '@/lib/color'
import { ensureLegibleForeground, errorForeground } from '@/lib/public-chat-theme'

// Surfaces a chat theme can put behind the composer: light, dark, tinted and mid-tone.
const SURFACES = ['#ffffff', '#f8fafc', '#fef2f2', '#000000', '#0f172a', '#1e293b', '#7f1d1d', '#b91c1c', '#fca5a5', '#808080', '#6b7280', '#ff0000']

describe('the colour of an error on a chat theme', () => {
  it.each(SURFACES)('reads at 4.5:1 or better on %s', (surface) => {
    expect(contrastRatio(surface, errorForeground(surface))).toBeGreaterThanOrEqual(4.5)
  })

  it('stays red on a light surface and a dark one when red can be read there', () => {
    expect(errorForeground('#ffffff')).toBe('#b91c1c')
    expect(errorForeground('#0f172a')).toBe('#fca5a5')
  })
})

describe('keeping a foreground legible', () => {
  it('keeps the colour it was given when it reads well enough on the background', () => {
    expect(ensureLegibleForeground('#ffffff', '#0f172a')).toBe('#0f172a')
  })

  it('falls back to the theme-friendly light or dark when it does not', () => {
    expect(ensureLegibleForeground('#ffffff', '#cccccc')).toBe('#0f172a')
  })

  it('falls back to pure black or white on a background where neither of those reaches the bar', () => {
    expect(ensureLegibleForeground('#ff0000', '#ff8080', 4.5)).toBe('#000000')
  })

  it('asks for more when the caller does', () => {
    // 3.6:1 passes the default bar and fails the one for text.
    const red = '#e5484d'
    expect(contrastRatio('#ffffff', red)).toBeGreaterThan(3)
    expect(contrastRatio('#ffffff', red)).toBeLessThan(4.5)
    expect(ensureLegibleForeground('#ffffff', red)).toBe(red)
    expect(ensureLegibleForeground('#ffffff', red, 4.5)).not.toBe(red)
  })
})
