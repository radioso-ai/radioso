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
      { id: 'web-chat', status: 'enabled', statusLabel: 'On' },
      { id: 'api-channel', status: 'active', statusLabel: 'Active' },
      { id: 'slack-channel', status: 'attention', statusLabel: 'Needs setup' },
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
    })).toEqual([{ id: 'web-chat', status: 'enabled', statusLabel: 'On' }])
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
    })).toEqual([{ id: 'whatsapp-channel', status: 'available', statusLabel: 'Available' }])

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
    })).toEqual([{ id: 'whatsapp-channel', status: 'active', statusLabel: 'Active' }])

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
    })).toEqual([{ id: 'whatsapp-channel', status: 'attention', statusLabel: 'Needs setup' }])
  })
})
