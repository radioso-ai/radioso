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

  it('addresses the agent logo by agent, so it resolves with every visitor channel switched off', () => {
    vi.stubGlobal('window', { location: { origin: 'https://app.example.com' } })

    const settings = agentToGeneralSettings({
      id: '00000000-0000-4000-8000-0000000000a1',
      workspaceId: '00000000-0000-4000-8000-0000000000b2',
      name: 'Support',
      greetingInstruction: null,
      assistantDefaultLocale: null,
      proactiveGreetingEnabled: true,
      assistantBootstrapActive: false,
      logo: {
        bucket: 'assistant-logos',
        objectPath: 'workspaces/ws-1/agents/agent-1/logo.png',
        mimeType: 'image/png',
        sizeBytes: 123,
        generation: null,
      },
      surfaceSettings: {
        anonymousChat: {
          enabled: false,
          token: null,
        },
        websiteEmbed: {
          enabled: false,
          token: null,
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

    const logoUrl = new URL(settings.assistantLogoUrl ?? '')
    expect(logoUrl.origin).toBe('https://app.example.com')
    expect(logoUrl.pathname).toBe('/backend/api/v1/agents/00000000-0000-4000-8000-0000000000a1/assistant-logo')
    expect(logoUrl.searchParams.get('workspaceId')).toBe('00000000-0000-4000-8000-0000000000b2')
    expect(logoUrl.searchParams.get('v')).toMatch(/^[a-z0-9]+::123$/)
    expect(logoUrl.searchParams.get('v')).not.toContain('workspaces/ws-1/agents/agent-1/logo.png')
  })
})
