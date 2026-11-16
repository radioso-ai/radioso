import type { EmailMailbox } from '@/lib/api-email-channel'

export type AgentChannelCatalogId =
  | 'web-chat'
  | 'api-channel'
  | 'mcp-channel'
  | 'slack-channel'
  | 'whatsapp-channel'
  | 'email-channel'

/**
 * What a listed channel is doing for one agent, independent of how it is rendered.
 * `on` means the channel can take traffic now; `needs-setup` means it is configured
 * and cannot serve; `not-set-up` means nothing is configured yet; `answered-elsewhere`
 * means a connection shared by the workspace is on, but another agent answers it.
 */
export type AgentChannelCatalogStatus = 'on' | 'needs-setup' | 'not-set-up' | 'answered-elsewhere'

export interface AgentChannelCatalogEntry {
  id: AgentChannelCatalogId
  status: AgentChannelCatalogStatus
  /**
   * Present when one connection serves the whole workspace instead of one per agent, and says
   * which agent answers it.
   */
  workspaceConnection?: { answeredBy: 'this-agent' | 'another-agent' }
}

interface AgentChannelCatalogInput {
  webChatEnabled: boolean
  apiCredentialCount: number
  mcpCredentialCount: number
  /** The deployment has a Slack app configured, so an operator can install it. */
  slackAvailable: boolean
  /** This agent is bound to a Slack channel or DM route. */
  slackBound: boolean
  slackConnected: boolean
  whatsappAvailable: boolean
  whatsappConfigured: boolean
  whatsappError: boolean
  /**
   * The workspace's WhatsApp number is answered by the workspace default agent only, so the
   * connection's health belongs to that agent and to no other.
   */
  whatsappAnsweredHere: boolean
  /** The deployment offers the email channel to this workspace. */
  emailAvailable: boolean
  /** The mailboxes bound to this agent. */
  emailMailboxes: ReadonlyArray<EmailMailboxHealth>
}

/** What is known about an agent's channels before the workspace's WhatsApp answerer is taken into account. */
export type AgentChannelFacts = Omit<AgentChannelCatalogInput, 'whatsappAnsweredHere'>

type EmailMailboxHealth = Pick<EmailMailbox, 'enabled'> & {
  receiving: Pick<EmailMailbox['receiving'], 'state'>
  sending: EmailMailbox['sending']
}

/**
 * The email channel's status for one agent. A mailbox needs attention when
 * forwarding may have stopped (silent) or its domain cannot send (unverified
 * or removed). Disabled mailboxes take no mail, so they never make the channel
 * on or ask for attention. Null when the channel is neither offered nor
 * configured.
 */
export function resolveEmailChannelStatus(
  available: boolean,
  mailboxes: ReadonlyArray<EmailMailboxHealth>,
): Exclude<AgentChannelCatalogStatus, 'answered-elsewhere'> | null {
  const enabled = mailboxes.filter((mailbox) => mailbox.enabled)
  if (enabled.length === 0) return available ? 'not-set-up' : null
  if (!available) return 'needs-setup'
  const unhealthy = enabled.some((mailbox) => mailbox.receiving.state === 'silent' || mailbox.sending.state !== 'ok')
  return unhealthy ? 'needs-setup' : 'on'
}

function resolveWhatsAppEntry(input: AgentChannelCatalogInput): AgentChannelCatalogEntry | null {
  if (!input.whatsappAvailable && !input.whatsappConfigured && !input.whatsappError) return null
  if (!input.whatsappAnsweredHere) {
    // Another agent answers the number, so a broken connection is that agent's to fix. Until the
    // number is set up nobody answers it, so there is nothing to attribute yet.
    return {
      id: 'whatsapp-channel',
      status: input.whatsappConfigured ? 'answered-elsewhere' : 'not-set-up',
      workspaceConnection: { answeredBy: 'another-agent' },
    }
  }
  return {
    id: 'whatsapp-channel',
    status: input.whatsappError ? 'needs-setup' : input.whatsappConfigured ? 'on' : 'not-set-up',
    workspaceConnection: { answeredBy: 'this-agent' },
  }
}

/**
 * Resolve every channel the deployment offers this agent, from the same
 * configuration surfaces each channel page uses. Web chat, the agent API and MCP are
 * always offered. Slack is listed once the deployment has a Slack app (or an
 * installation or binding already exists), WhatsApp once its connector is registered
 * (or already configured) and email once the deployment offers it (or a mailbox
 * exists), so an operator is never sent to a channel that cannot be set up.
 *
 * Slack is on when the workspace app is connected and this agent is bound; bound
 * to a disconnected app it needs setup. A connected app this agent is not bound
 * to is simply not set up for this agent.
 */
export function resolveAgentChannelCatalog(input: AgentChannelCatalogInput): AgentChannelCatalogEntry[] {
  const entries: AgentChannelCatalogEntry[] = [
    { id: 'web-chat', status: input.webChatEnabled ? 'on' : 'not-set-up' },
    { id: 'api-channel', status: input.apiCredentialCount > 0 ? 'on' : 'not-set-up' },
    { id: 'mcp-channel', status: input.mcpCredentialCount > 0 ? 'on' : 'not-set-up' },
  ]
  if (input.slackAvailable || input.slackBound || input.slackConnected) {
    entries.push({
      id: 'slack-channel',
      status: !input.slackBound ? 'not-set-up' : input.slackConnected ? 'on' : 'needs-setup',
    })
  }
  const whatsapp = resolveWhatsAppEntry(input)
  if (whatsapp) entries.push(whatsapp)
  const emailStatus = resolveEmailChannelStatus(input.emailAvailable, input.emailMailboxes)
  if (emailStatus) entries.push({ id: 'email-channel', status: emailStatus })
  return entries
}

interface AgentChannelSummary {
  onCount: number
  /** At least one configured channel cannot serve. */
  needsSetup: boolean
}

/** What the Channels row shows in the agent menu: "N on", or "Needs setup" when anything is broken. */
export function summarizeAgentChannels(entries: ReadonlyArray<AgentChannelCatalogEntry>): AgentChannelSummary {
  return {
    onCount: entries.filter((entry) => entry.status === 'on').length,
    needsSetup: entries.some((entry) => entry.status === 'needs-setup'),
  }
}

interface AgentChannelGroups {
  needsSetup: AgentChannelCatalogEntry[]
  on: AgentChannelCatalogEntry[]
  notSetUp: AgentChannelCatalogEntry[]
  answeredElsewhere: AgentChannelCatalogEntry[]
}

/** The Channels overview's three lists, each keeping the catalog's order. */
export function groupAgentChannels(entries: ReadonlyArray<AgentChannelCatalogEntry>): AgentChannelGroups {
  return {
    needsSetup: entries.filter((entry) => entry.status === 'needs-setup'),
    on: entries.filter((entry) => entry.status === 'on'),
    notSetUp: entries.filter((entry) => entry.status === 'not-set-up'),
    answeredElsewhere: entries.filter((entry) => entry.status === 'answered-elsewhere'),
  }
}
