import { describe, expect, it } from 'vitest'

import {
  buildWebsiteEmbedTestHarnessUrl,
  buildWebsiteEmbedSnippet,
  formatWebsiteEmbedOrigins,
  LOCAL_WEBSITE_EMBED_TEST_HARNESS_URL,
  normalizeWebsiteEmbedDisplayMode,
  normalizeWebsiteEmbedInitialState,
  normalizeWebsiteEmbedLocale,
  parseWebsiteEmbedCopyOverridesParam,
  parseWebsiteEmbedThemeOverridesParam,
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
    })

    expect(snippet).toContain('src="https://app.example.com/radioso-embed.js"')
    expect(snippet).toContain('data-radioso-token="embed-token"')
    expect(snippet).not.toContain('data-radioso-launcher-position')
    expect(snippet).not.toContain('data-radioso-theme')
    expect(snippet).not.toContain('data-radioso-copy')
  })

  it('escapes quote-bearing values in the generated snippet', () => {
    const snippet = buildWebsiteEmbedSnippet({
      websiteEmbedEnabled: true,
      websiteEmbedToken: 'embed-"token"',
      websiteEmbedScriptUrl: 'https://app.example.com/radioso-embed.js?x="1"',
    })

    expect(snippet).toContain('src="https://app.example.com/radioso-embed.js?x=&quot;1&quot;"')
    expect(snippet).toContain('data-radioso-token="embed-&quot;token&quot;"')
    expect(snippet).not.toContain('data-radioso-launcher-label')
  })

  it('resolves the script URL from a provided base URL', () => {
    expect(resolveWebsiteEmbedScriptUrl(null, 'https://app.example.com/chat/token')).toBe(
      'https://app.example.com/radioso-embed.js',
    )
  })

  it('keeps optional overrides out of the install snippet', () => {
    const snippet = buildWebsiteEmbedSnippet(
      {
        websiteEmbedEnabled: true,
        websiteEmbedToken: 'embed-token',
        websiteEmbedScriptUrl: 'https://app.example.com/radioso-embed.js',
      },
    )

    expect(snippet).not.toContain('data-radioso-display-mode')
    expect(snippet).not.toContain('data-radioso-initial-state')
    expect(snippet).not.toContain('data-radioso-avatar-url')
    expect(snippet).not.toContain('data-radioso-page-context')
  })

  it('builds a local harness URL from the current embed settings and overrides', () => {
    const harnessUrl = buildWebsiteEmbedTestHarnessUrl(
      {
        websiteEmbedToken: 'embed-token',
        websiteEmbedScriptUrl: 'https://app.example.com/radioso-embed.js',
        websiteEmbedLauncherLabel: 'Talk to us',
        websiteEmbedLauncherPosition: 'bottom-left',
      },
      undefined,
      {
        displayMode: 'panel',
        initialState: 'open',
        copy: { publicChatEmptyTitle: 'Bonjour' },
        theme: { accent: '#123456' },
      },
    )

    expect(harnessUrl).toContain(`${LOCAL_WEBSITE_EMBED_TEST_HARNESS_URL}/?`)
    const url = new URL(harnessUrl ?? '')
    expect(url.searchParams.get('appOrigin')).toBe('https://app.example.com')
    expect(url.searchParams.get('token')).toBe('embed-token')
    expect(url.searchParams.get('label')).toBe('Talk to us')
    expect(url.searchParams.get('position')).toBe('bottom-left')
    expect(url.searchParams.get('displayMode')).toBe('panel')
    expect(url.searchParams.get('initialState')).toBe('open')
    expect(url.searchParams.get('avatarUrl')).toBeNull()
  })

  it('builds a hosted harness URL when an app base URL is available', () => {
    const harnessUrl = buildWebsiteEmbedTestHarnessUrl(
      {
        websiteEmbedToken: 'embed-token',
        websiteEmbedScriptUrl: 'https://app.example.com/radioso-embed.js',
        websiteEmbedLauncherLabel: 'Talk to us',
        websiteEmbedLauncherPosition: 'bottom-left',
      },
      'https://app.example.com/settings',
    )

    const url = new URL(harnessUrl ?? '')
    expect(url.origin).toBe('https://app.example.com')
    expect(url.pathname).toBe('/embed-test')
    expect(url.searchParams.get('appOrigin')).toBe('https://app.example.com')
    expect(url.searchParams.get('token')).toBe('embed-token')
  })

  it('preserves an explicitly empty launcher label in the test harness URL', () => {
    const harnessUrl = buildWebsiteEmbedTestHarnessUrl(
      {
        websiteEmbedToken: 'embed-token',
        websiteEmbedScriptUrl: 'https://app.example.com/radioso-embed.js',
        websiteEmbedLauncherLabel: '',
        websiteEmbedLauncherPosition: 'bottom-right',
      },
      'https://app.example.com/settings',
    )

    const url = new URL(harnessUrl ?? '')
    expect(url.searchParams.has('label')).toBe(true)
    expect(url.searchParams.get('label')).toBe('')
  })

  it('normalizes locale, display-mode, and initial-state overrides', () => {
    expect(normalizeWebsiteEmbedLocale(' it-IT ')).toBe('it-IT')
    expect(normalizeWebsiteEmbedDisplayMode(' PANEL ')).toBe('panel')
    expect(normalizeWebsiteEmbedInitialState('OPEN')).toBe('open')
  })

  it('drops unsupported override values', () => {
    expect(normalizeWebsiteEmbedLocale('not_a_locale')).toBeNull()
    expect(normalizeWebsiteEmbedDisplayMode('drawer')).toBeNull()
    expect(normalizeWebsiteEmbedInitialState('sideways')).toBeNull()
  })

  it('parses copy and theme overrides from serialized params', () => {
    expect(
      parseWebsiteEmbedCopyOverridesParam(
        '{"publicChatEmptyTitle":"Translated title","publicChatRateLimitRetryTemplate":"Retry in {seconds}s"}',
      ),
    ).toEqual({
      publicChatEmptyTitle: 'Translated title',
      publicChatRateLimitRetryTemplate: 'Retry in {seconds}s',
    })
    expect(parseWebsiteEmbedThemeOverridesParam('{"accent":"#123456","panelBackground":"#fafafa"}')).toEqual({
      accent: '#123456',
      panelBackground: '#fafafa',
    })
  })
})
