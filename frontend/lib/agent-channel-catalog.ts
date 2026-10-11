import type { EmailMailbox } from '@/lib/api-email-channel'

export type AgentChannelCatalogId =
  | 'web-chat'
  | 'api-channel'
  | 'mcp-channel'
  | 'slack-channel'
  | 'whatsapp-channel'
  | 'email-channel'

/**
 * What a listed channel is doing, independent of how the sidebar renders it.
 * `active` means the channel can take traffic now; `available` means the
 * channel is offered but nothing is configured yet; `attention` means it is
 * configured and cannot serve.
 */
export type AgentChannelCatalogStatus = 'active' | 'available' | 'attention'

interface AgentChannelCatalogEntry {
  id: AgentChannelCatalogId
  status: AgentChannelCatalogStatus
}

interface AgentChannelCatalogInput {
  webChatEnabled: boolean
  apiCredentialCount: number
  mcpCredentialCount: number
  slackConfigured: boolean
  slackConnected: boolean
  slackBound: boolean
  whatsappAvailable: boolean
  whatsappConfigured: boolean
  whatsappError: boolean
  /** The deployment offers the email channel to this workspace. */
  emailAvailable: boolean
  /** The mailboxes bound to this agent. */
  emailMailboxes: ReadonlyArray<EmailMailboxHealth>
}

type EmailMailboxHealth = Pick<EmailMailbox, 'enabled'> & {
  receiving: Pick<EmailMailbox['receiving'], 'state'>
  sending: EmailMailbox['sending']
}

/**
 * The email channel's status for one agent. A mailbox needs attention when
 * forwarding may have stopped (silent) or its domain cannot send (unverified
 * or removed). Disabled mailboxes take no mail, so they never make the channel
 * active or ask for attention. Null when the channel is neither offered nor
 * configured.
 */
export function resolveEmailChannelStatus(
  available: boolean,
  mailboxes: ReadonlyArray<EmailMailboxHealth>,
): AgentChannelCatalogStatus | null {
  const enabled = mailboxes.filter((mailbox) => mailbox.enabled)
  if (enabled.length === 0) return available ? 'available' : null
  if (!available) return 'attention'
  const unhealthy = enabled.some((mailbox) => mailbox.receiving.state === 'silent' || mailbox.sending.state !== 'ok')
  return unhealthy ? 'attention' : 'active'
}

/**
 * Resolve the sidebar's channel list from the same channel configuration
 * surfaces used by each settings card. Unsupported channels stay out of the
 * compact list; configured attention states remain visible so they can be
 * repaired from their settings page. WhatsApp is the one channel listed before
 * configuration: when the connector is registered it appears as `available`, so
 * operators can discover it from the sidebar. Email follows the same rule once
 * the deployment offers it.
 */
export function resolveAgentChannelCatalog(input: AgentChannelCatalogInput): AgentChannelCatalogEntry[] {
  const entries: AgentChannelCatalogEntry[] = []
  if (input.webChatEnabled) entries.push({ id: 'web-chat', status: 'active' })
  if (input.apiCredentialCount > 0) entries.push({ id: 'api-channel', status: 'active' })
  if (input.mcpCredentialCount > 0) entries.push({ id: 'mcp-channel', status: 'active' })
  if (input.slackConfigured || input.slackConnected || input.slackBound) {
    entries.push({
      id: 'slack-channel',
      status: input.slackConnected && input.slackBound ? 'active' : 'attention',
    })
  }
  if (input.whatsappAvailable || input.whatsappConfigured || input.whatsappError) {
    entries.push({
      id: 'whatsapp-channel',
      status: input.whatsappError ? 'attention' : input.whatsappConfigured ? 'active' : 'available',
    })
  }
  const emailStatus = resolveEmailChannelStatus(input.emailAvailable, input.emailMailboxes)
  if (emailStatus) entries.push({ id: 'email-channel', status: emailStatus })
  return entries
}
