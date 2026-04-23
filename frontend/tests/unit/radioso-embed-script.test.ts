import { describe, expect, it } from 'vitest'

import {
  formatWebsiteEmbedRateLimitRetry,
  getWebsiteEmbedCopy,
  getWebsiteEmbedTheme,
  normalizeWebsiteEmbedAvatarUrl,
  normalizeWebsiteEmbedInitialState,
  normalizeWebsiteEmbedLocale,
  sanitizeWebsiteEmbedCopyOverrides,
  sanitizeWebsiteEmbedThemeOverrides,
} from '@/lib/embed-widget'

describe('website embed runtime helpers', () => {
  it('uses English copy by default, even when a locale hint is present', () => {
    expect(getWebsiteEmbedCopy('it-IT').launcherDefaultLabel).toBe('Chat with us')
    expect(getWebsiteEmbedCopy('es-ES').startPrompt).toBe('Ask a question...')
    expect(getWebsiteEmbedCopy('xx-ZZ').launcherDefaultLabel).toBe('Chat with us')
  })

  it('accepts only supported initial-state and avatar values', () => {
    expect(normalizeWebsiteEmbedInitialState('collapsed')).toBe('collapsed')
    expect(normalizeWebsiteEmbedInitialState('invalid')).toBeNull()
    expect(normalizeWebsiteEmbedAvatarUrl('https://cdn.example.com/avatar.png')).toBe(
      'https://cdn.example.com/avatar.png',
    )
    expect(normalizeWebsiteEmbedAvatarUrl('data:image/png;base64,abc')).toBeNull()
    expect(normalizeWebsiteEmbedLocale('de-DE')).toBe('de-DE')
  })

  it('sanitizes copy and theme overrides and formats retry text', () => {
    const copyOverrides = sanitizeWebsiteEmbedCopyOverrides({
      publicChatSendMessageLabel: 'Enviar',
      invalidKey: 'ignored',
    })
    const theme = getWebsiteEmbedTheme(
      sanitizeWebsiteEmbedThemeOverrides({
        accent: '#112233',
        unsupported: '#ffffff',
      }),
    )
    const copy = getWebsiteEmbedCopy('en-US', {
      publicChatRateLimitRetryTemplate: 'Retry in {seconds} seconds.',
    })

    expect(copyOverrides).toEqual({ publicChatSendMessageLabel: 'Enviar' })
    expect(theme.accent).toBe('#112233')
    expect(formatWebsiteEmbedRateLimitRetry(copy, 7)).toBe('Retry in 7 seconds.')
  })
})
