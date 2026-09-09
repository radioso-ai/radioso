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
    })).toEqual([])
  })
})
