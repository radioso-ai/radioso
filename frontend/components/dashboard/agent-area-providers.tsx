'use client'

import { usePathname } from 'next/navigation'
import type { ReactNode } from 'react'

import { AgentChannelsProvider } from '@/lib/agent-channels-context'
import { AgentRevisionProvider } from '@/lib/agent-revision-context'
import { AgentsProvider } from '@/lib/agents-context'
import { useAuth } from '@/lib/auth-context'
import { useWorkspace } from '@/lib/workspace-context'

/**
 * The agent area is `/w/<workspace>/agents[/<agent>[/routines/<routine>]]`; the agent is in the path.
 * Moving between agents changes the path's segments, which remounts the dashboard page, so the ports
 * the area shares live above the page and read the route themselves.
 */
const agentAreaRoute = (pathname: string): { enabled: boolean; agentId: string | undefined } => {
  const [section, agentId] = pathname.split('/').filter(Boolean).slice(2)
  return { enabled: section === 'agents', agentId: section === 'agents' ? agentId : undefined }
}

/**
 * The three ports the agent area shares: the agent list and selection, the selected agent's channels,
 * and its draft state. The list is the root: the channels and the draft state both belong to the agent
 * it selects. Nothing is read while `enabled` is off, which is whenever another part of the dashboard is on screen.
 */
export function AgentAreaPorts({
  workspaceId,
  routeAgentId,
  enabled,
  children,
}: {
  workspaceId: string | null
  routeAgentId: string | undefined
  enabled: boolean
  children: ReactNode
}) {
  return (
    <AgentsProvider workspaceId={workspaceId} routeAgentId={routeAgentId} enabled={enabled}>
      <AgentChannelsProvider workspaceId={workspaceId} enabled={enabled}>
        <AgentRevisionProvider enabled={enabled}>{children}</AgentRevisionProvider>
      </AgentChannelsProvider>
    </AgentsProvider>
  )
}

/** The agent area's ports, fed by the route and the signed-in workspace. */
export function AgentAreaProviders({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const { user } = useAuth()
  const { activeWorkspaceId } = useWorkspace()
  const { enabled, agentId } = agentAreaRoute(pathname)
  return (
    // What one operator's session read is not carried into the next one's.
    <AgentAreaPorts key={user?.accountId ?? 'signed-out'} workspaceId={activeWorkspaceId} routeAgentId={agentId} enabled={enabled}>
      {children}
    </AgentAreaPorts>
  )
}
