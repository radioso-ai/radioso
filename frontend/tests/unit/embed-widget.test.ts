import { describe, expect, it } from 'vitest'

import {
  buildWebsiteEmbedSurfaceCssVars,
  buildWebsiteEmbedTestHarnessUrl,
  buildWebsiteEmbedSnippet,
  formatWebsiteEmbedDisclaimer,
  formatWebsiteEmbedOrigins,
  formatWebsiteEmbedRateLimitRetry,
  formatWebsiteEmbedStartingMessage,
  getWebsiteEmbedCopy,
  getWebsiteEmbedTheme,
  LOCAL_WEBSITE_EMBED_TEST_HARNESS_URL,
  normalizeWebsiteEmbedAvatarUrl,
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
        displayMode: 'panel',
        initialState: 'open',
        avatarUrl: 'https://cdn.example.com/avatar.gif',
        copy: {
          publicChatEmptyTitle: 'Ask us anything',
        },
        theme: {
          accent: '#112233',
          panelBackground: '#f5f5f5',
        },
      },
    )

    expect(snippet).toContain('data-radioso-display-mode="panel"')
    expect(snippet).toContain('data-radioso-initial-state="open"')
    expect(snippet).toContain('data-radioso-avatar-url="https://cdn.example.com/avatar.gif"')
    expect(snippet).toContain('data-radioso-copy="{&quot;publicChatEmptyTitle&quot;:&quot;Ask us anything&quot;}"')
    expect(snippet).toContain(
      'data-radioso-theme="{&quot;accent&quot;:&quot;#112233&quot;,&quot;panelBackground&quot;:&quot;#f5f5f5&quot;}"',
    )
  })

  it('builds a local harness URL from the current embed settings and overrides', () => {
    const harnessUrl = buildWebsiteEmbedTestHarnessUrl(
      {
        websiteEmbedToken: 'embed-token',
        websiteEmbedScriptUrl: 'https://app.example.com/radioso-embed.js',
        websiteEmbedLauncherLabel: 'Talk to us',
        websiteEmbedLauncherIcon: 'message',
        websiteEmbedLauncherPosition: 'bottom-left',
      },
      undefined,
      {
        displayMode: 'panel',
        initialState: 'open',
        avatarUrl: 'https://cdn.example.com/avatar.gif',
        copy: { publicChatEmptyTitle: 'Bonjour' },
        theme: { accent: '#123456' },
      },
    )

    expect(harnessUrl).toContain(`${LOCAL_WEBSITE_EMBED_TEST_HARNESS_URL}/?`)
    const url = new URL(harnessUrl ?? '')
    expect(url.searchParams.get('appOrigin')).toBe('https://app.example.com')
    expect(url.searchParams.get('token')).toBe('embed-token')
    expect(url.searchParams.get('label')).toBe('Talk to us')
    expect(url.searchParams.get('icon')).toBe('message')
    expect(url.searchParams.get('position')).toBe('bottom-left')
    expect(url.searchParams.get('displayMode')).toBe('panel')
    expect(url.searchParams.get('initialState')).toBe('open')
    expect(url.searchParams.get('avatarUrl')).toBe('https://cdn.example.com/avatar.gif')
    expect(url.searchParams.get('copy')).toBe('{"publicChatEmptyTitle":"Bonjour"}')
    expect(url.searchParams.get('theme')).toBe('{"accent":"#123456"}')
  })

  it('supports a custom same-origin demo page URL', () => {
    const harnessUrl = buildWebsiteEmbedTestHarnessUrl(
      {
        websiteEmbedToken: 'embed-token',
        websiteEmbedScriptUrl: 'https://app.example.com/radioso-embed.js',
        websiteEmbedLauncherLabel: 'Talk to us',
        websiteEmbedLauncherIcon: 'message',
        websiteEmbedLauncherPosition: 'bottom-left',
      },
      'https://app.example.com',
      undefined,
      'https://app.example.com/embed-demo.html',
    )

    expect(harnessUrl).toBe(
      'https://app.example.com/embed-demo.html?appOrigin=https%3A%2F%2Fapp.example.com&token=embed-token&label=Talk+to+us&icon=message&position=bottom-left',
    )
  })

  it('normalizes locale, display-mode, initial-state, and avatar overrides', () => {
    expect(normalizeWebsiteEmbedLocale(' it-IT ')).toBe('it-IT')
    expect(normalizeWebsiteEmbedDisplayMode(' PANEL ')).toBe('panel')
    expect(normalizeWebsiteEmbedInitialState('OPEN')).toBe('open')
    expect(normalizeWebsiteEmbedAvatarUrl('https://cdn.example.com/avatar.gif')).toBe(
      'https://cdn.example.com/avatar.gif',
    )
    expect(normalizeWebsiteEmbedAvatarUrl('/images/support.gif')).toBe('/images/support.gif')
  })

  it('drops unsupported override values', () => {
    expect(normalizeWebsiteEmbedLocale('not_a_locale')).toBeNull()
    expect(normalizeWebsiteEmbedDisplayMode('drawer')).toBeNull()
    expect(normalizeWebsiteEmbedInitialState('sideways')).toBeNull()
    expect(normalizeWebsiteEmbedAvatarUrl('javascript:alert(1)')).toBeNull()
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

  it('merges English-default copy and theme overrides into the resolved appearance', () => {
    const copy = getWebsiteEmbedCopy('fr-FR', { publicChatEmptyTitle: 'Bonjour' })
    const theme = getWebsiteEmbedTheme({ accent: '#224466' })

    expect(copy.publicChatEmptyTitle).toBe('Bonjour')
    expect(formatWebsiteEmbedRateLimitRetry(copy, 12)).toBe('Try again in 12s.')
    expect(formatWebsiteEmbedStartingMessage(copy)).toBe('Summoning Radioso embedded chat...')
    expect(formatWebsiteEmbedDisclaimer(copy, 'Support concierge')).toBe(
      'Support concierge uses AI and can make mistakes.',
    )
    expect(theme.accent).toBe('#224466')
  })

  it('maps the embed theme onto route-scoped surface tokens', () => {
    const cssVars = buildWebsiteEmbedSurfaceCssVars(
      getWebsiteEmbedTheme({
        panelBackground: '#faf7f2',
        panelForeground: '#1c2434',
        accent: '#335577',
        accentForeground: '#f7fbff',
        mutedBackground: '#f2ede5',
        mutedForeground: '#6a7280',
        panelBorder: '#d7d0c6',
        inputBorder: '#c4b9aa',
      }),
    )

    expect(cssVars['--background']).toBe('#faf7f2')
    expect(cssVars['--foreground']).toBe('#1c2434')
    expect(cssVars['--primary']).toBe('#335577')
    expect(cssVars['--primary-foreground']).toBe('#f7fbff')
    expect(cssVars['--muted']).toBe('#f2ede5')
    expect(cssVars['--muted-foreground']).toBe('#6a7280')
    expect(cssVars['--accent']).toBe('#f2ede5')
    expect(cssVars['--accent-foreground']).toBe('#1c2434')
    expect(cssVars['--border']).toBe('#d7d0c6')
    expect(cssVars['--input']).toBe('#c4b9aa')
  })

  it('formats the startup copy with the configured embedded chat name', () => {
    expect(
      formatWebsiteEmbedStartingMessage({
        embeddedChatStartingMessage: 'Summoning {name}...',
        embeddedChatTitle: 'Support concierge',
      }),
    ).toBe('Summoning Support concierge...')
    expect(
      formatWebsiteEmbedStartingMessage({
        embeddedChatStartingMessage: 'Connecting now',
        embeddedChatTitle: 'Ignored name',
      }),
    ).toBe('Connecting now')
    expect(
      formatWebsiteEmbedDisclaimer(
        {
          publicChatDisclaimerTemplate: '{name} uses AI and can make mistakes.',
        },
        'Support concierge',
      ),
    ).toBe('Support concierge uses AI and can make mistakes.')
  })
})
