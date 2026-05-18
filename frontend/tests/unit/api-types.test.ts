import { afterEach, describe, expect, it, vi } from 'vitest'

import { agentToGeneralSettings, type AgentSettings } from '@/lib/api-types'

describe('api type mappers', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uses the generated embed widget route for agent website embed settings', () => {
    vi.stubGlobal('window', { location: { origin: 'https://app.example.com' } })

    const settings = agentToGeneralSettings({
      name: 'Support',
      greetingInstruction: null,
      assistantDefaultLocale: null,
      proactiveGreetingEnabled: true,
      assistantBootstrapActive: false,
      logo: null,
      surfaceSettings: {
        anonymousChat: {
          enabled: false,
          token: null,
        },
        websiteEmbed: {
          enabled: true,
          token: 'embed-token',
          allowedOrigins: [],
          launcherLabel: 'Chat',
          launcherPosition: 'bottom-right',
          theme: {
            brand: '#0f172a',
            brandText: '#f8fafc',
            surface: '#ffffff',
            text: '#0f172a',
          },
          copy: {},
          expertOverrides: {},
        },
      },
    } as unknown as AgentSettings)

    expect(settings.websiteEmbedScriptUrl).toBe('https://app.example.com/radioso-embed.js')
  })
})
