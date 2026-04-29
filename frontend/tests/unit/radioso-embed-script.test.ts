import { describe, expect, it } from 'vitest'

import {
  WEBSITE_EMBED_DESKTOP_PANEL_WIDTH_PX,
  WEBSITE_EMBED_NARROW_VIEWPORT_MAX_WIDTH_PX,
  WEBSITE_EMBED_PANEL_HANDLE_WIDTH_PX,
  getWebsiteEmbedTheme,
  normalizeWebsiteEmbedAvatarUrl,
  normalizeWebsiteEmbedDisplayMode,
  normalizeWebsiteEmbedInitialState,
  normalizeWebsiteEmbedLocale,
  sanitizeWebsiteEmbedCopyOverrides,
  sanitizeWebsiteEmbedThemeOverrides,
  shouldUseWebsiteEmbedCompactKeyboardLayout,
} from '@/lib/embed-widget'

describe('website embed runtime helpers', () => {
  it('accepts only supported display-mode, initial-state, and avatar values', () => {
    expect(normalizeWebsiteEmbedDisplayMode('panel')).toBe('panel')
    expect(normalizeWebsiteEmbedDisplayMode('sidebar')).toBeNull()
    expect(normalizeWebsiteEmbedInitialState('collapsed')).toBe('collapsed')
    expect(normalizeWebsiteEmbedInitialState('invalid')).toBeNull()
    expect(normalizeWebsiteEmbedAvatarUrl('https://cdn.example.com/avatar.png')).toBe(
      'https://cdn.example.com/avatar.png',
    )
    expect(normalizeWebsiteEmbedAvatarUrl('data:image/png;base64,abc')).toBeNull()
    expect(normalizeWebsiteEmbedLocale('de-DE')).toBe('de-DE')
  })

  it('sanitizes copy and theme overrides', () => {
    const copyOverrides = sanitizeWebsiteEmbedCopyOverrides({
      publicChatSendMessageLabel: 'Enviar',
      publicChatDisclaimerTemplate: '{name} puede cometer errores.',
      invalidKey: 'ignored',
    })
    const theme = getWebsiteEmbedTheme(
      sanitizeWebsiteEmbedThemeOverrides({
        accent: '#112233',
        unsupported: '#ffffff',
      }),
    )

    expect(copyOverrides.invalidKey).toBeUndefined()
    expect(Object.keys(copyOverrides)).toHaveLength(2)
    expect(theme.accent).toBeTruthy()
  })

  it('keeps embed sizing constants aligned with the launcher layout', () => {
    expect(WEBSITE_EMBED_DESKTOP_PANEL_WIDTH_PX).toBe(560)
    expect(WEBSITE_EMBED_PANEL_HANDLE_WIDTH_PX).toBe(56)
    expect(WEBSITE_EMBED_NARROW_VIEWPORT_MAX_WIDTH_PX).toBe(640)
  })

  it('uses compact keyboard layout only for narrow focused keyboard states', () => {
    expect(
      shouldUseWebsiteEmbedCompactKeyboardLayout({
        viewportWidth: 900,
        layoutViewportHeight: 800,
        visualViewportHeight: 500,
        editableFocused: true,
      }),
    ).toBe(false)
    expect(
      shouldUseWebsiteEmbedCompactKeyboardLayout({
        viewportWidth: 390,
        layoutViewportHeight: 800,
        visualViewportHeight: 760,
        editableFocused: true,
      }),
    ).toBe(false)
    expect(
      shouldUseWebsiteEmbedCompactKeyboardLayout({
        viewportWidth: 390,
        layoutViewportHeight: 800,
        visualViewportHeight: 440,
        editableFocused: true,
      }),
    ).toBe(true)
    expect(
      shouldUseWebsiteEmbedCompactKeyboardLayout({
        viewportWidth: 390,
        layoutViewportHeight: 800,
        visualViewportHeight: null,
        editableFocused: true,
      }),
    ).toBe(true)
    expect(
      shouldUseWebsiteEmbedCompactKeyboardLayout({
        viewportWidth: 390,
        layoutViewportHeight: 800,
        visualViewportHeight: 440,
        editableFocused: false,
      }),
    ).toBe(false)
  })
})
