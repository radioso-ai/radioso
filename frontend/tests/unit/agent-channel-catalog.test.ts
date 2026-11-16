import { describe, expect, it } from 'vitest'

import {
  groupAgentChannels,
  resolveAgentChannelCatalog,
  summarizeAgentChannels,
  type AgentChannelCatalogEntry,
} from '@/lib/agent-channel-catalog'

const noChannels = {
  webChatEnabled: false,
  apiCredentialCount: 0,
  mcpCredentialCount: 0,
  slackBound: false,
  slackConnected: false,
  whatsappAvailable: false,
  whatsappConfigured: false,
  whatsappError: false,
  whatsappAnsweredHere: true,
  emailAvailable: false,
  emailMailboxes: [],
}

const statusOf = (entries: AgentChannelCatalogEntry[], id: AgentChannelCatalogEntry['id']) =>
  entries.find((entry) => entry.id === id)?.status

const mailbox = ({ receiving, sending, enabled = true }: {
  receiving: 'waiting_for_first_message' | 'ok' | 'silent'
  sending: 'ok' | 'not_verified' | 'domain_removed'
  enabled?: boolean
}) => ({ enabled, receiving: { state: receiving }, sending: { state: sending } })

describe('agent channel catalog', () => {
  it('always lists web chat, the agent API, MCP and Slack, and reports what is configured', () => {
    expect(resolveAgentChannelCatalog(noChannels)).toEqual([
      { id: 'web-chat', status: 'not-set-up' },
      { id: 'api-channel', status: 'not-set-up' },
      { id: 'mcp-channel', status: 'not-set-up' },
      { id: 'slack-channel', status: 'not-set-up' },
    ])
    expect(resolveAgentChannelCatalog({
      ...noChannels,
      webChatEnabled: true,
      apiCredentialCount: 1,
      mcpCredentialCount: 2,
    }).map((entry) => entry.status)).toEqual(['on', 'on', 'on', 'not-set-up'])
  })

  it('treats Slack as on only when the app is connected and the agent is bound', () => {
    expect(statusOf(resolveAgentChannelCatalog({ ...noChannels, slackBound: true, slackConnected: true }), 'slack-channel')).toBe('on')
    expect(statusOf(resolveAgentChannelCatalog({ ...noChannels, slackBound: true, slackConnected: false }), 'slack-channel')).toBe('needs-setup')
    // Connected for another agent: nothing here is broken, the channel is just not set up for this agent.
    expect(statusOf(resolveAgentChannelCatalog({ ...noChannels, slackBound: false, slackConnected: true }), 'slack-channel')).toBe('not-set-up')
  })

  it('keeps WhatsApp out of the list until the connector is registered or configured', () => {
    expect(statusOf(resolveAgentChannelCatalog(noChannels), 'whatsapp-channel')).toBeUndefined()
    expect(statusOf(resolveAgentChannelCatalog({ ...noChannels, whatsappConfigured: true }), 'whatsapp-channel')).toBe('on')
  })

  it('reflects WhatsApp setup and errors on the agent that answers the number', () => {
    const whatsapp = (overrides: Partial<typeof noChannels>) =>
      resolveAgentChannelCatalog({ ...noChannels, whatsappAvailable: true, ...overrides }).find((entry) => entry.id === 'whatsapp-channel')
    const here = { workspaceConnection: { answeredBy: 'this-agent' } }
    expect(whatsapp({})).toEqual({ id: 'whatsapp-channel', status: 'not-set-up', ...here })
    expect(whatsapp({ whatsappConfigured: true })).toEqual({ id: 'whatsapp-channel', status: 'on', ...here })
    expect(whatsapp({ whatsappConfigured: true, whatsappError: true })).toEqual({ id: 'whatsapp-channel', status: 'needs-setup', ...here })
  })

  it('does not count or flag WhatsApp on an agent that does not answer the number', () => {
    const whatsapp = (overrides: Partial<typeof noChannels>) =>
      resolveAgentChannelCatalog({ ...noChannels, whatsappAvailable: true, whatsappAnsweredHere: false, ...overrides }).find((entry) => entry.id === 'whatsapp-channel')
    const elsewhere = { id: 'whatsapp-channel', status: 'not-set-up', workspaceConnection: { answeredBy: 'another-agent' } }
    expect(whatsapp({ whatsappConfigured: true })).toEqual(elsewhere)
    // A broken connection is the answering agent's to fix, so it cannot turn this agent's row amber.
    expect(whatsapp({ whatsappConfigured: true, whatsappError: true })).toEqual(elsewhere)
    expect(whatsapp({})).toEqual(elsewhere)
  })

  it('lists email as not set up once the server offers it, before any mailbox exists', () => {
    expect(statusOf(resolveAgentChannelCatalog({ ...noChannels, emailAvailable: true }), 'email-channel')).toBe('not-set-up')
    expect(statusOf(resolveAgentChannelCatalog({ ...noChannels, emailAvailable: false }), 'email-channel')).toBeUndefined()
  })

  it('shows email as on when every enabled mailbox receives and its domain is verified', () => {
    expect(statusOf(resolveAgentChannelCatalog({
      ...noChannels,
      emailAvailable: true,
      emailMailboxes: [
        mailbox({ receiving: 'ok', sending: 'ok' }),
        mailbox({ receiving: 'waiting_for_first_message', sending: 'ok' }),
      ],
    }), 'email-channel')).toBe('on')
  })

  it('asks for setup when a mailbox has gone silent, is not verified, or was removed', () => {
    const email = (receiving: 'ok' | 'silent', sending: 'ok' | 'not_verified' | 'domain_removed') =>
      statusOf(resolveAgentChannelCatalog({
        ...noChannels,
        emailAvailable: true,
        emailMailboxes: [mailbox({ receiving: 'ok', sending: 'ok' }), mailbox({ receiving, sending })],
      }), 'email-channel')
    expect(email('silent', 'ok')).toBe('needs-setup')
    expect(email('ok', 'not_verified')).toBe('needs-setup')
    expect(email('ok', 'domain_removed')).toBe('needs-setup')
  })

  it('judges email only by enabled mailboxes, and flags mailboxes the server can no longer serve', () => {
    expect(statusOf(resolveAgentChannelCatalog({
      ...noChannels,
      emailAvailable: true,
      emailMailboxes: [mailbox({ receiving: 'silent', sending: 'not_verified', enabled: false })],
    }), 'email-channel')).toBe('not-set-up')
    expect(statusOf(resolveAgentChannelCatalog({
      ...noChannels,
      emailAvailable: false,
      emailMailboxes: [mailbox({ receiving: 'ok', sending: 'ok' })],
    }), 'email-channel')).toBe('needs-setup')
  })
})

describe('agent channel summary and grouping', () => {
  const entries: AgentChannelCatalogEntry[] = [
    { id: 'web-chat', status: 'on' },
    { id: 'api-channel', status: 'not-set-up' },
    { id: 'mcp-channel', status: 'not-set-up' },
    { id: 'slack-channel', status: 'needs-setup' },
    { id: 'email-channel', status: 'on' },
  ]

  it('counts the channels that are on and says when any needs setup', () => {
    expect(summarizeAgentChannels(entries)).toEqual({ onCount: 2, needsSetup: true })
    expect(summarizeAgentChannels(entries.filter((entry) => entry.status !== 'needs-setup'))).toEqual({ onCount: 2, needsSetup: false })
    expect(summarizeAgentChannels([])).toEqual({ onCount: 0, needsSetup: false })
  })

  it('groups into needs setup, on and not set up, keeping catalog order', () => {
    const groups = groupAgentChannels(entries)
    expect(groups.needsSetup.map((entry) => entry.id)).toEqual(['slack-channel'])
    expect(groups.on.map((entry) => entry.id)).toEqual(['web-chat', 'email-channel'])
    expect(groups.notSetUp.map((entry) => entry.id)).toEqual(['api-channel', 'mcp-channel'])
  })
})
