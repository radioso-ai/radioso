import { describe, expect, it } from 'vitest'

import {
  getWebsiteEmbedCopy,
  normalizeWebsiteEmbedAvatarUrl,
  normalizeWebsiteEmbedInitialState,
  normalizeWebsiteEmbedLocale,
} from '@/lib/embed-widget'

describe('website embed runtime helpers', () => {
  it('resolves localized copy for supported locale overrides', () => {
    expect(getWebsiteEmbedCopy('it-IT').launcherDefaultLabel).toBe('Chatta con noi')
    expect(getWebsiteEmbedCopy('es-ES').startPrompt).toBe('Haz una pregunta...')
  })

  it('falls back to English copy for unsupported locale overrides', () => {
    expect(getWebsiteEmbedCopy('xx-ZZ').launcherDefaultLabel).toBe('Chat with us')
  })

  it('accepts only supported initial-state and avatar values', () => {
    expect(normalizeWebsiteEmbedInitialState('collapsed')).toBe('collapsed')
    expect(normalizeWebsiteEmbedInitialState('invalid')).toBeNull()
    expect(normalizeWebsiteEmbedAvatarUrl('https://cdn.example.com/avatar.png')).toBe(
      'https://cdn.example.com/avatar.png',
    )
    expect(normalizeWebsiteEmbedAvatarUrl('data:image/png;base64,abc')).toBeNull()
    expect(normalizeWebsiteEmbedLocale('de-DE')).toBe('de')
  })
})
