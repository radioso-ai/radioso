import { describe, expect, it } from 'vitest'

import { resolveAgentChannelCatalog } from '@/lib/agent-channel-catalog'

const noChannels = {
  webChatEnabled: false,
  apiCredentialCount: 0,
  mcpCredentialCount: 0,
  slackConfigured: false,
  slackConnected: false,
  slackBound: false,
  whatsappAvailable: false,
  whatsappConfigured: false,
  whatsappError: false,
  emailAvailable: false,
  emailMailboxes: [],
}

const mailbox = ({ receiving, sending, enabled = true }: {
  receiving: 'waiting_for_first_message' | 'ok' | 'silent'
  sending: 'ok' | 'not_verified' | 'domain_removed'
  enabled?: boolean
}) => ({ enabled, receiving: { state: receiving }, sending: { state: sending } })

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
      emailAvailable: false,
      emailMailboxes: [],
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
      emailAvailable: false,
      emailMailboxes: [],
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
      emailAvailable: false,
      emailMailboxes: [],
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
      emailAvailable: false,
      emailMailboxes: [],
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
      emailAvailable: false,
      emailMailboxes: [],
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
      emailAvailable: false,
      emailMailboxes: [],
    })).toEqual([{ id: 'whatsapp-channel', status: 'attention' }])
  })

  it('lists email as available once the server offers it, before any mailbox exists', () => {
    expect(resolveAgentChannelCatalog({ ...noChannels, emailAvailable: true, emailMailboxes: [] }))
      .toEqual([{ id: 'email-channel', status: 'available' }])
    expect(resolveAgentChannelCatalog({ ...noChannels, emailAvailable: false, emailMailboxes: [] })).toEqual([])
  })

  it('shows email as active when every enabled mailbox receives and its domain is verified', () => {
    expect(resolveAgentChannelCatalog({
      ...noChannels,
      emailAvailable: true,
      emailMailboxes: [
        mailbox({ receiving: 'ok', sending: 'ok' }),
        mailbox({ receiving: 'waiting_for_first_message', sending: 'ok' }),
      ],
    })).toEqual([{ id: 'email-channel', status: 'active' }])
  })

  it('asks for attention when a mailbox has gone silent', () => {
    expect(resolveAgentChannelCatalog({
      ...noChannels,
      emailAvailable: true,
      emailMailboxes: [mailbox({ receiving: 'ok', sending: 'ok' }), mailbox({ receiving: 'silent', sending: 'ok' })],
    })).toEqual([{ id: 'email-channel', status: 'attention' }])
  })

  it('asks for attention when a mailbox domain is not verified or was removed', () => {
    expect(resolveAgentChannelCatalog({
      ...noChannels,
      emailAvailable: true,
      emailMailboxes: [mailbox({ receiving: 'ok', sending: 'not_verified' })],
    })).toEqual([{ id: 'email-channel', status: 'attention' }])
    expect(resolveAgentChannelCatalog({
      ...noChannels,
      emailAvailable: true,
      emailMailboxes: [mailbox({ receiving: 'ok', sending: 'domain_removed' })],
    })).toEqual([{ id: 'email-channel', status: 'attention' }])
  })

  it('judges email only by enabled mailboxes, and flags mailboxes the server can no longer serve', () => {
    expect(resolveAgentChannelCatalog({
      ...noChannels,
      emailAvailable: true,
      emailMailboxes: [mailbox({ receiving: 'silent', sending: 'not_verified', enabled: false })],
    })).toEqual([{ id: 'email-channel', status: 'available' }])
    expect(resolveAgentChannelCatalog({
      ...noChannels,
      emailAvailable: false,
      emailMailboxes: [mailbox({ receiving: 'ok', sending: 'ok' })],
    })).toEqual([{ id: 'email-channel', status: 'attention' }])
  })
})
