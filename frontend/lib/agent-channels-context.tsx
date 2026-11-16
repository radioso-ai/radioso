'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

import { agentsApi } from '@/lib/api'
import { agentChannelCredentialsApi } from '@/lib/api-agent-channel-credentials'
import { connectorsApi } from '@/lib/api-connectors'
import { emailChannelApi } from '@/lib/api-email-channel'
import { slackApi } from '@/lib/api-slack'
import { resolveAgentChannelCatalog, type AgentChannelCatalogEntry, type AgentChannelFacts } from '@/lib/agent-channel-catalog'
import { getAgentOperatorLabel } from '@/lib/agent-label'
import { useAgents } from '@/lib/agents-context'

/**
 * Where the selected agent's channels stand. The agent menu's Channels row and the Channels overview
 * read the same entries, so the two cannot disagree about what is on and the facts are fetched once.
 */
export interface AgentChannelsPort {
  /** Null until the first read lands. */
  entries: AgentChannelCatalogEntry[] | null
  /** The agent that answers the workspace's shared WhatsApp number, for rows that name it. */
  whatsappAnsweringAgentName: string | null
  /** Reads the channels again; a channel page calls it after it changes one. */
  refresh: () => void
}

const detachedPort: AgentChannelsPort = { entries: null, whatsappAnsweringAgentName: null, refresh: () => undefined }

const AgentChannelsContext = createContext<AgentChannelsPort>(detachedPort)

export const useAgentChannels = (): AgentChannelsPort => useContext(AgentChannelsContext)

const activeCredentialCount = (result: PromiseSettledResult<{ credentials: Array<{ status: string }> }>) =>
  result.status === 'fulfilled' ? result.value.credentials.filter((credential) => credential.status === 'active').length : 0

async function readChannelFacts(workspaceId: string, agentId: string): Promise<AgentChannelFacts> {
  const [general, rest, mcp, slack, bindings, whatsappConnector, emailOverview] = await Promise.allSettled([
    agentsApi.getGeneralSettings(agentId),
    agentChannelCredentialsApi.list(agentId, 'rest'),
    agentChannelCredentialsApi.list(agentId, 'mcp'),
    slackApi.getInstallStatus(workspaceId, agentId),
    slackApi.listBindings(workspaceId, agentId),
    connectorsApi.get('whatsapp'),
    emailChannelApi.getOverview(workspaceId),
  ])
  const generalSettings = general.status === 'fulfilled' ? general.value : null
  const slackStatus = slack.status === 'fulfilled' ? slack.value : null
  const slackBindings = bindings.status === 'fulfilled' ? bindings.value.bindings : []
  const whatsapp = whatsappConnector.status === 'fulfilled' ? whatsappConnector.value : null
  const email = emailOverview.status === 'fulfilled' ? emailOverview.value : null
  return {
    webChatEnabled: Boolean(generalSettings?.anonymousChatEnabled || generalSettings?.websiteEmbedEnabled),
    apiCredentialCount: activeCredentialCount(rest),
    mcpCredentialCount: activeCredentialCount(mcp),
    slackAvailable: slackStatus?.readiness.configured ?? false,
    slackBound: slackBindings.some((binding) => binding.answeringAgentId === agentId),
    slackConnected: slackStatus?.status === 'connected',
    whatsappAvailable: whatsappConnector.status === 'fulfilled',
    whatsappConfigured: whatsapp?.enabled ?? false,
    whatsappError: Boolean(whatsapp?.errorStatus),
    emailAvailable: email?.configured ?? false,
    emailMailboxes: email?.mailboxes.filter((mailbox) => mailbox.agentId === agentId) ?? [],
  }
}

export function AgentChannelsProvider({
  workspaceId,
  enabled,
  children,
}: {
  workspaceId: string | null
  enabled: boolean
  children: ReactNode
}) {
  const { agents, selectedAgent } = useAgents()
  const agentId = selectedAgent?.id
  const [read, setRead] = useState<{ agentId: string; facts: AgentChannelFacts } | null>(null)
  const [version, setVersion] = useState(0)

  useEffect(() => {
    if (!enabled || !workspaceId || !agentId) return
    let active = true
    void readChannelFacts(workspaceId, agentId).then((facts) => {
      if (active) setRead({ agentId, facts })
    })
    return () => { active = false }
  }, [agentId, enabled, version, workspaceId])

  const refresh = useCallback(() => setVersion((value) => value + 1), [])

  // The WhatsApp number has no per-agent binding: its turns resolve to the default agent, so only that
  // agent counts it. This reads the live list, so a rename of that agent shows without another read.
  const defaultAgent = agents.find((agent) => agent.isDefault) ?? null
  const facts = read && read.agentId === agentId ? read.facts : null
  const entries = useMemo(
    () => facts ? resolveAgentChannelCatalog({ ...facts, whatsappAnsweredHere: defaultAgent ? defaultAgent.id === agentId : true }) : null,
    [agentId, defaultAgent, facts],
  )
  const port = useMemo<AgentChannelsPort>(
    () => ({ entries, whatsappAnsweringAgentName: defaultAgent ? getAgentOperatorLabel(defaultAgent) : null, refresh }),
    [defaultAgent, entries, refresh],
  )

  return <AgentChannelsContext.Provider value={port}>{children}</AgentChannelsContext.Provider>
}
