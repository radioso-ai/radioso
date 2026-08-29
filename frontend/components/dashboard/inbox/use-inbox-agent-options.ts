'use client'

import { useEffect, useState } from 'react'

import { agentsApi } from '@/lib/api-settings'
import type { InboxAgentOption } from '@/lib/needs-attention'

/**
 * The workspace's full agent list for the queue's Agent filter, so the
 * dropdown offers every agent (matching the mock's "Agent: all / Gioia /
 * Claudio") rather than only agents that currently have an open item.
 */
export const useInboxAgentOptions = (enabled: boolean): InboxAgentOption[] => {
  const [agents, setAgents] = useState<InboxAgentOption[]>([])

  useEffect(() => {
    if (!enabled) {
      return
    }
    let cancelled = false

    void agentsApi.listAgents()
      .then((response) => {
        if (cancelled) {
          return
        }
        setAgents(response.agents.map((agent) => ({
          agentId: agent.id,
          agentName: agent.name ?? null,
          agentInternalName: agent.internalName ?? null,
        })))
      })
      .catch(() => {
        // The filter degrades to the agents already present in the open queue.
      })

    return () => {
      cancelled = true
    }
  }, [enabled])

  return agents
}
