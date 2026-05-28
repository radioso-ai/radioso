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

  it('uses the enabled website embed token for agent logo URLs when anonymous chat is disabled', () => {
    vi.stubGlobal('window', { location: { origin: 'https://app.example.com' } })

    const settings = agentToGeneralSettings({
      name: 'Support',
      greetingInstruction: null,
      assistantDefaultLocale: null,
      proactiveGreetingEnabled: true,
      assistantBootstrapActive: false,
      logo: {
        bucket: 'assistant-logos',
        objectPath: 'workspaces/ws-1/agents/agent-1/logo.png',
        mimeType: 'image/png',
        size: 123,
        generation: null,
      },
      surfaceSettings: {
        anonymousChat: {
          enabled: false,
          token: 'disabled-anonymous-token',
        },
        websiteEmbed: {
          enabled: true,
          token: 'enabled-embed-token',
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

    expect(settings.assistantLogoUrl).toBe(
      'https://app.example.com/backend/api/v1/public/chat/enabled-embed-token/assistant-logo',
    )
  })
})
