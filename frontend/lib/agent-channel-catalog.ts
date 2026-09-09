export type AgentChannelCatalogId = 'web-chat' | 'api-channel' | 'mcp-channel' | 'slack-channel' | 'whatsapp-channel'
type AgentChannelCatalogStatus = 'active' | 'enabled' | 'attention' | 'available'

interface AgentChannelCatalogEntry {
  id: AgentChannelCatalogId
  status: AgentChannelCatalogStatus
  statusLabel: string
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
 * surfaces used by each settings card. Unsupported or entirely unconfigured
 * channels stay out of the compact list; configured attention states remain
 * visible so they can be repaired from their settings page.
 */
export function resolveAgentChannelCatalog(input: AgentChannelCatalogInput): AgentChannelCatalogEntry[] {
  const entries: AgentChannelCatalogEntry[] = []
  if (input.webChatEnabled) entries.push({ id: 'web-chat', status: 'enabled', statusLabel: 'On' })
  if (input.apiCredentialCount > 0) entries.push({ id: 'api-channel', status: 'active', statusLabel: 'Active' })
  if (input.mcpCredentialCount > 0) {
    entries.push({
      id: 'mcp-channel',
      status: 'active',
      statusLabel: 'Active',
    })
  }
  if (input.slackConfigured || input.slackConnected || input.slackBound) {
    entries.push({
      id: 'slack-channel',
      status: input.slackConnected && input.slackBound ? 'active' : 'attention',
      statusLabel: input.slackConnected && input.slackBound ? 'Active' : 'Needs setup',
    })
  }
  if (input.whatsappAvailable || input.whatsappConfigured || input.whatsappError) {
    entries.push({
      id: 'whatsapp-channel',
      status: input.whatsappError ? 'attention' : input.whatsappConfigured ? 'active' : 'available',
      statusLabel: input.whatsappError ? 'Needs setup' : input.whatsappConfigured ? 'Active' : 'Available',
    })
  }
  return entries
}
