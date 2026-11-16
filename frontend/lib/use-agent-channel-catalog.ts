'use client'

import { useEffect, useState } from 'react'

import { agentsApi } from '@/lib/api'
import { agentChannelCredentialsApi } from '@/lib/api-agent-channel-credentials'
import { connectorsApi } from '@/lib/api-connectors'
import { emailChannelApi } from '@/lib/api-email-channel'
import { slackApi } from '@/lib/api-slack'
import { resolveAgentChannelCatalog, type AgentChannelCatalogEntry } from '@/lib/agent-channel-catalog'
import { getAgentOperatorLabel } from '@/lib/agent-label'

interface AgentChannelCatalogState {
  /** Null until the first read lands. */
  entries: AgentChannelCatalogEntry[] | null
  /** The agent that answers the workspace's shared WhatsApp number, for rows that name it. */
  whatsappAnsweringAgentName: string | null
}

/**
 * Reads every channel's setup facts for one agent and resolves them into the catalog. The agent menu's
 * Channels row and the Channels overview both read it, so the two cannot disagree about what is on.
 * `refreshKey` re-reads when the operator may have changed a channel since the last read.
 */
export function useAgentChannelCatalog({
  workspaceId,
  agentId,
  refreshKey,
}: {
  workspaceId: string | null | undefined
  agentId: string | undefined
  refreshKey?: string
}): AgentChannelCatalogState {
  const [catalog, setCatalog] = useState<AgentChannelCatalogState & { agentId: string | undefined }>({
    agentId: undefined,
    entries: null,
    whatsappAnsweringAgentName: null,
  })

  useEffect(() => {
    if (!workspaceId || !agentId) return
    let active = true
    void Promise.allSettled([
      agentsApi.getGeneralSettings(agentId),
      agentChannelCredentialsApi.list(agentId, 'rest'),
      agentChannelCredentialsApi.list(agentId, 'mcp'),
      slackApi.getInstallStatus(workspaceId, agentId),
      slackApi.listBindings(workspaceId, agentId),
      connectorsApi.get('whatsapp'),
      emailChannelApi.getOverview(workspaceId),
      agentsApi.listAgents(),
    ]).then(([general, rest, mcp, slack, bindings, whatsappConnector, emailOverview, agents]) => {
      if (!active) return
      const generalSettings = general.status === 'fulfilled' ? general.value : null
      const activeCredentials = (result: typeof rest) =>
        result.status === 'fulfilled' ? result.value.credentials.filter((credential) => credential.status === 'active').length : 0
      const slackStatus = slack.status === 'fulfilled' ? slack.value : null
      const slackBindings = bindings.status === 'fulfilled' ? bindings.value.bindings : []
      const whatsapp = whatsappConnector.status === 'fulfilled' ? whatsappConnector.value : null
      const email = emailOverview.status === 'fulfilled' ? emailOverview.value : null
      const agentList = agents.status === 'fulfilled' ? agents.value.agents : []
      // The workspace's WhatsApp number has no per-agent binding: its turns resolve to the default agent.
      const defaultAgent = agentList.find((agent) => agent.isDefault) ?? null
      setCatalog({
        agentId,
        whatsappAnsweringAgentName: defaultAgent ? getAgentOperatorLabel(defaultAgent) : null,
        entries: resolveAgentChannelCatalog({
          webChatEnabled: Boolean(generalSettings?.anonymousChatEnabled || generalSettings?.websiteEmbedEnabled),
          apiCredentialCount: activeCredentials(rest),
          mcpCredentialCount: activeCredentials(mcp),
          slackBound: slackBindings.some((binding) => binding.answeringAgentId === agentId),
          slackConnected: slackStatus?.status === 'connected',
          whatsappAvailable: whatsappConnector.status === 'fulfilled',
          whatsappConfigured: whatsapp?.enabled ?? false,
          whatsappError: Boolean(whatsapp?.errorStatus),
          whatsappAnsweredHere: defaultAgent ? defaultAgent.id === agentId : true,
          emailAvailable: email?.configured ?? false,
          emailMailboxes: email?.mailboxes.filter((mailbox) => mailbox.agentId === agentId) ?? [],
        }),
      })
    })
    return () => { active = false }
  }, [workspaceId, agentId, refreshKey])

  // Entries read for another agent describe that agent, so they are never shown for this one.
  return catalog.agentId === agentId
    ? { entries: catalog.entries, whatsappAnsweringAgentName: catalog.whatsappAnsweringAgentName }
    : { entries: null, whatsappAnsweringAgentName: null }
}
