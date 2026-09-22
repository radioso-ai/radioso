import { describe, expect, it } from 'vitest'

import { resolveAgentChannelCatalog } from '@/lib/agent-channel-catalog'

describe('agent channel catalog', () => {
  it('lists configured channels and keeps disconnected setup attention visible', () => {
    expect(resolveAgentChannelCatalog({
      webChatEnabled: true,
      apiCredentialCount: 1,
      mcpCredentialCount: 0,
      slackConfigured: true,
      slackConnected: false,
      slackBound: true,
      whatsappAvailable: false,
      whatsappConfigured: false,
      whatsappError: false,
    })).toEqual([
      { id: 'web-chat', status: 'active' },
      { id: 'api-channel', status: 'active' },
      { id: 'slack-channel', status: 'attention' },
    ])
  })

  it('does not infer a web chat setup problem from an unused channel', () => {
    expect(resolveAgentChannelCatalog({
      webChatEnabled: true,
      apiCredentialCount: 0,
      mcpCredentialCount: 0,
      slackConfigured: false,
      slackConnected: false,
      slackBound: false,
      whatsappAvailable: false,
      whatsappConfigured: false,
      whatsappError: false,
    })).toEqual([{ id: 'web-chat', status: 'active' }])
  })

  it('does not list MCP from runtime availability without an agent credential', () => {
    expect(resolveAgentChannelCatalog({
      webChatEnabled: false,
      apiCredentialCount: 0,
      mcpCredentialCount: 0,
      slackConfigured: false,
      slackConnected: false,
      slackBound: false,
      whatsappAvailable: false,
      whatsappConfigured: false,
      whatsappError: false,
    })).toEqual([])
  })

  it('shows an available WhatsApp connector and reflects configured or error status', () => {
    expect(resolveAgentChannelCatalog({
      webChatEnabled: false,
      apiCredentialCount: 0,
      mcpCredentialCount: 0,
      slackConfigured: false,
      slackConnected: false,
      slackBound: false,
      whatsappAvailable: true,
      whatsappConfigured: false,
      whatsappError: false,
    })).toEqual([{ id: 'whatsapp-channel', status: 'available' }])

    expect(resolveAgentChannelCatalog({
      webChatEnabled: false,
      apiCredentialCount: 0,
      mcpCredentialCount: 0,
      slackConfigured: false,
      slackConnected: false,
      slackBound: false,
      whatsappAvailable: true,
      whatsappConfigured: true,
      whatsappError: false,
    })).toEqual([{ id: 'whatsapp-channel', status: 'active' }])

    expect(resolveAgentChannelCatalog({
      webChatEnabled: false,
      apiCredentialCount: 0,
      mcpCredentialCount: 0,
      slackConfigured: false,
      slackConnected: false,
      slackBound: false,
      whatsappAvailable: true,
      whatsappConfigured: true,
      whatsappError: true,
    })).toEqual([{ id: 'whatsapp-channel', status: 'attention' }])
  })
})
