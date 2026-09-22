export type AgentChannelCatalogId = 'web-chat' | 'api-channel' | 'mcp-channel' | 'slack-channel' | 'whatsapp-channel'

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
}

/**
 * Resolve the sidebar's channel list from the same channel configuration
 * surfaces used by each settings card. Unsupported channels stay out of the
 * compact list; configured attention states remain visible so they can be
 * repaired from their settings page. WhatsApp is the one channel listed before
 * configuration: when the connector is registered it appears as `available`, so
 * operators can discover it from the sidebar.
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
  return entries
}
