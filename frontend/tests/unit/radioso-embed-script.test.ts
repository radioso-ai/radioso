import { describe, expect, it } from 'vitest'

import {
  getWebsiteEmbedTheme,
  normalizeWebsiteEmbedAvatarUrl,
  normalizeWebsiteEmbedDisplayMode,
  normalizeWebsiteEmbedInitialState,
  normalizeWebsiteEmbedLocale,
  sanitizeWebsiteEmbedCopyOverrides,
  sanitizeWebsiteEmbedThemeOverrides,
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
})
