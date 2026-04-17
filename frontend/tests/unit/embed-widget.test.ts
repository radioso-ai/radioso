import { describe, expect, it } from 'vitest'

import {
  buildWebsiteEmbedSnippet,
  formatWebsiteEmbedOrigins,
  normalizeWebsiteEmbedAvatarUrl,
  normalizeWebsiteEmbedInitialState,
  normalizeWebsiteEmbedLocale,
  parseWebsiteEmbedOrigins,
  resolveWebsiteEmbedScriptUrl,
} from '@/lib/embed-widget'

describe('embed widget helpers', () => {
  it('normalizes and filters approved origins', () => {
    expect(parseWebsiteEmbedOrigins(' https://example.com/path \ninvalid\nhttps://docs.example.com')).toEqual([
      'https://example.com',
      'https://docs.example.com',
    ])
  })

  it('formats origins as newline separated values', () => {
    expect(formatWebsiteEmbedOrigins(['https://example.com', 'https://docs.example.com'])).toBe(
      'https://example.com\nhttps://docs.example.com',
    )
  })

  it('builds a copyable install snippet when website embed is enabled', () => {
    const snippet = buildWebsiteEmbedSnippet({
      websiteEmbedEnabled: true,
      websiteEmbedToken: 'embed-token',
      websiteEmbedScriptUrl: 'https://app.example.com/radioso-embed.js',
      websiteEmbedAllowedOrigins: ['https://example.com'],
      websiteEmbedLauncherLabel: 'Talk to us',
      websiteEmbedLauncherIcon: 'sparkles',
      websiteEmbedLauncherPosition: 'bottom-left',
    })

    expect(snippet).toContain('src="https://app.example.com/radioso-embed.js"')
    expect(snippet).toContain('data-radioso-token="embed-token"')
    expect(snippet).toContain('data-radioso-launcher-position="bottom-left"')
  })

  it('escapes quote-bearing values in the generated snippet', () => {
    const snippet = buildWebsiteEmbedSnippet({
      websiteEmbedEnabled: true,
      websiteEmbedToken: 'embed-"token"',
      websiteEmbedScriptUrl: 'https://app.example.com/radioso-embed.js?x="1"',
      websiteEmbedAllowedOrigins: ['https://example.com'],
      websiteEmbedLauncherLabel: 'Chat "now"',
      websiteEmbedLauncherIcon: 'sparkles',
      websiteEmbedLauncherPosition: 'bottom-left',
    })

    expect(snippet).toContain('src="https://app.example.com/radioso-embed.js?x=&quot;1&quot;"')
    expect(snippet).toContain('data-radioso-token="embed-&quot;token&quot;"')
    expect(snippet).toContain('data-radioso-launcher-label="Chat &quot;now&quot;"')
  })

  it('resolves the script URL from a provided base URL', () => {
    expect(resolveWebsiteEmbedScriptUrl(null, 'https://app.example.com/chat/token')).toBe(
      'https://app.example.com/radioso-embed.js',
    )
  })

  it('adds optional script-level override attributes to the snippet', () => {
    const snippet = buildWebsiteEmbedSnippet(
      {
        websiteEmbedEnabled: true,
        websiteEmbedToken: 'embed-token',
        websiteEmbedScriptUrl: 'https://app.example.com/radioso-embed.js',
        websiteEmbedAllowedOrigins: ['https://example.com'],
        websiteEmbedLauncherLabel: 'Chat with us',
        websiteEmbedLauncherIcon: 'chat',
        websiteEmbedLauncherPosition: 'bottom-right',
      },
      undefined,
      {
        locale: 'it-IT',
        initialState: 'open',
        collapsedAvatarUrl: 'https://cdn.example.com/avatar.gif',
      },
    )

    expect(snippet).toContain('data-radioso-locale="it-IT"')
    expect(snippet).toContain('data-radioso-initial-state="open"')
    expect(snippet).toContain('data-radioso-collapsed-avatar-url="https://cdn.example.com/avatar.gif"')
  })

  it('normalizes supported locale, initial-state, and avatar overrides', () => {
    expect(normalizeWebsiteEmbedLocale(' it-IT ')).toBe('it')
    expect(normalizeWebsiteEmbedInitialState('OPEN')).toBe('open')
    expect(normalizeWebsiteEmbedAvatarUrl('https://cdn.example.com/avatar.gif')).toBe(
      'https://cdn.example.com/avatar.gif',
    )
    expect(normalizeWebsiteEmbedAvatarUrl('/images/support.gif')).toBe('/images/support.gif')
  })

  it('drops unsupported override values', () => {
    expect(normalizeWebsiteEmbedLocale('not_a_locale')).toBeNull()
    expect(normalizeWebsiteEmbedInitialState('sideways')).toBeNull()
    expect(normalizeWebsiteEmbedAvatarUrl('javascript:alert(1)')).toBeNull()
  })
})
