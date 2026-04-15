import { describe, expect, it } from 'vitest'

import {
  buildWebsiteEmbedSnippet,
  formatWebsiteEmbedOrigins,
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

  it('resolves the script URL from a provided base URL', () => {
    expect(resolveWebsiteEmbedScriptUrl(null, 'https://app.example.com/chat/token')).toBe(
      'https://app.example.com/radioso-embed.js',
    )
  })
})
