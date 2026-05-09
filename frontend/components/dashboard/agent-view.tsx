'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { RefreshCw } from 'lucide-react'

import { ChatView } from '@/components/dashboard/chat-view'
import { DashboardPage } from '@/components/dashboard/shared/dashboard-page'
import { WorkspaceAssistantChannelsTab } from '@/components/dashboard/settings/workspace-assistant-channels-tab'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  buildDashboardHref,
  type AgentTab,
  type DashboardRouteState,
} from '@/lib/dashboard-routes'
import { agentsApi, type AgentSettings } from '@/lib/api'
import { getLastSelectedAgentId, setLastSelectedAgentId } from '@/lib/agent-selection'
import { useWorkspace } from '@/lib/workspace-context'
import { type WorkspaceOnboardingState } from '@/lib/onboarding'

const agentTabSummaries: Record<AgentTab, string> = {
  chat: 'Test the selected agent against this workspace knowledge.',
  behavior: 'Control the selected agent identity, instructions, and answer behavior.',
  channels: 'Control where users can access this agent.',
}

export function AgentView({
  accountId,
  routeState,
  onboarding,
  onOpenDocument,
}: {
  accountId: string
  routeState: DashboardRouteState
  onboarding: WorkspaceOnboardingState
  onOpenDocument: (documentId: string) => void
}) {
  const router = useRouter()
  const { activeWorkspaceId } = useWorkspace()
  const activeTab = routeState.agentTab ?? 'chat'
  const [agents, setAgents] = useState<AgentSettings[]>([])
  const [agentsError, setAgentsError] = useState<string | null>(null)
  const [isAgentsLoading, setIsAgentsLoading] = useState(true)
  const [saveState, setSaveState] = useState<{
    state: 'idle' | 'saved' | 'saving' | 'error'
    message?: string | null
  }>({ state: 'idle' })

  const loadAgents = useCallback(async () => {
    if (!activeWorkspaceId) {
      setAgents([])
      setIsAgentsLoading(false)
      return
    }
    setIsAgentsLoading(true)
    try {
      const response = await agentsApi.listAgents()
      setAgents(response.agents)
      setAgentsError(null)
    } catch {
      setAgents([])
      setAgentsError('Failed to load agents')
    } finally {
      setIsAgentsLoading(false)
    }
  }, [activeWorkspaceId])

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void loadAgents()
    }, 0)

    return () => window.clearTimeout(timeout)
  }, [loadAgents, routeState.agentId])

  useEffect(() => {
    const handleAgentsUpdated = () => {
      void loadAgents()
    }

    window.addEventListener('radioso:agents-updated', handleAgentsUpdated)
    window.addEventListener('radioso:assistant-name-updated', handleAgentsUpdated)
    return () => {
      window.removeEventListener('radioso:agents-updated', handleAgentsUpdated)
      window.removeEventListener('radioso:assistant-name-updated', handleAgentsUpdated)
    }
  }, [loadAgents])

  const fallbackAgent = useMemo(() => agents[0] ?? null, [agents])
  const rememberedAgentId = getLastSelectedAgentId(activeWorkspaceId)
  const selectedAgent = useMemo(
    () => {
      if (routeState.agentId) {
        return agents.find((agent) => agent.id === routeState.agentId)
          ?? agents.find((agent) => agent.id === rememberedAgentId)
          ?? fallbackAgent
      }
      return agents.find((agent) => agent.id === rememberedAgentId) ?? fallbackAgent
    },
    [agents, fallbackAgent, rememberedAgentId, routeState.agentId],
  )
  const selectedAgentId = selectedAgent?.id
  const agentSelectionPending = isAgentsLoading
  const agentSelectionUnavailable = Boolean(!isAgentsLoading && (agentsError || !selectedAgent))

  useEffect(() => {
    if (selectedAgentId) {
      setLastSelectedAgentId(activeWorkspaceId, selectedAgentId)
    }
  }, [activeWorkspaceId, selectedAgentId])

  useEffect(() => {
    if (isAgentsLoading || agentsError || !selectedAgentId || routeState.agentId === selectedAgentId) {
      return
    }

    const timeout = window.setTimeout(() => {
      router.replace(buildDashboardHref(accountId, {
        ...routeState,
        section: 'agents',
        agentId: selectedAgentId,
        anchor: undefined,
      }))
    }, 0)

    return () => window.clearTimeout(timeout)
  }, [accountId, agentsError, isAgentsLoading, routeState, router, selectedAgentId])

  const tabNavigation = (
    <div className="flex flex-wrap items-center gap-2">
      <TabsList>
        <TabsTrigger value="chat">Chat</TabsTrigger>
        <TabsTrigger value="behavior">Behavior</TabsTrigger>
        <TabsTrigger value="channels">Channels</TabsTrigger>
      </TabsList>
    </div>
  )

  const saveStateAccessory = (
    <div className="text-sm">
      {saveState.state === 'saving' ? (
        <span className="text-muted-foreground">Saving...</span>
      ) : saveState.state === 'error' ? (
        <span className="text-destructive">
          {saveState.message ?? 'Failed to save changes'}
        </span>
      ) : saveState.state === 'saved' ? (
        <span className="text-muted-foreground">Saved</span>
      ) : null}
    </div>
  )

  const agentUnavailableContent = agentSelectionPending ? (
    <div className="flex min-h-48 items-center justify-center text-sm text-muted-foreground">
      <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
      Loading agent...
    </div>
  ) : agentsError ? (
    <div className="flex min-h-48 flex-col items-start justify-center gap-3 p-6">
      <div>
        <p className="font-medium text-foreground">Unable to load agent</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Agent details could not be loaded. Try again before chatting or editing this agent.
        </p>
      </div>
      <Button type="button" variant="outline" onClick={() => void loadAgents()}>
        Retry
      </Button>
    </div>
  ) : (
    <div className="flex min-h-48 flex-col items-start justify-center gap-3 p-6">
      <div>
        <p className="font-medium text-foreground">Agent not found</p>
        <p className="mt-1 text-sm text-muted-foreground">
          This agent may have been deleted or may not belong to the current workspace.
        </p>
      </div>
      <Button
        type="button"
        variant="outline"
        onClick={() => router.push(buildDashboardHref(accountId, {
          ...routeState,
          section: 'agents',
          agentId: undefined,
          anchor: undefined,
        }))}
      >
        Open an agent
      </Button>
    </div>
  )

  const renderAgentUnavailablePage = (description: string) => (
    <DashboardPage
      title="Agent"
      description={agentsError ?? description}
      titleAccessory={saveStateAccessory}
      actions={tabNavigation}
      contentClassName="flex flex-col overflow-hidden p-0"
      contentScroll={false}
    >
      {agentUnavailableContent}
    </DashboardPage>
  )

  useEffect(() => {
    if (!routeState.anchor) {
      return
    }

    const element = document.getElementById(routeState.anchor)
    if (!element) {
      router.replace(buildDashboardHref(accountId, {
        ...routeState,
        section: 'agents',
        anchor: undefined,
      }))
      return
    }

    element.scrollIntoView({ block: 'start', behavior: 'auto' })
  }, [accountId, routeState, router])

  return (
    <Tabs
      value={activeTab}
      onValueChange={(value) => {
        setSaveState({ state: 'idle' })
        router.push(buildDashboardHref(accountId, {
          ...routeState,
          section: 'agents',
          agentTab: value as AgentTab,
          anchor: undefined,
        }))
      }}
      className="h-full min-h-0 gap-0"
    >
      <TabsContent value="chat" className="min-h-0 flex flex-1 flex-col overflow-hidden">
        {agentSelectionPending || agentSelectionUnavailable ? (
          renderAgentUnavailablePage(agentTabSummaries.chat)
        ) : (
          <ChatView
            key={selectedAgentId}
            accountId={accountId}
            agentId={selectedAgentId}
            onOpenDocument={onOpenDocument}
            onboarding={onboarding}
            navigation={tabNavigation}
          />
        )}
      </TabsContent>

      <TabsContent value="behavior" className="min-h-0 flex flex-1 flex-col overflow-hidden">
        {agentSelectionPending || agentSelectionUnavailable ? (
          renderAgentUnavailablePage(agentTabSummaries.behavior)
        ) : (
          <DashboardPage
            title="Agent"
            description={agentsError ?? selectedAgent?.name ?? agentTabSummaries.behavior}
            titleAccessory={saveStateAccessory}
            actions={tabNavigation}
            contentClassName="flex flex-col overflow-hidden p-0"
            contentScroll={false}
          >
            <WorkspaceAssistantChannelsTab accountId={accountId} mode="assistant" agentId={selectedAgentId} onSaveStateChange={setSaveState} />
          </DashboardPage>
        )}
      </TabsContent>

      <TabsContent value="channels" className="min-h-0 flex flex-1 flex-col overflow-hidden">
        {agentSelectionPending || agentSelectionUnavailable ? (
          renderAgentUnavailablePage(agentTabSummaries.channels)
        ) : (
          <DashboardPage
            title="Agent"
            description={agentsError ?? selectedAgent?.name ?? agentTabSummaries.channels}
            titleAccessory={saveStateAccessory}
            actions={tabNavigation}
            contentClassName="flex flex-col overflow-hidden p-0"
            contentScroll={false}
          >
            <WorkspaceAssistantChannelsTab accountId={accountId} mode="channels" agentId={selectedAgentId} onSaveStateChange={setSaveState} />
          </DashboardPage>
        )}
      </TabsContent>
    </Tabs>
  )
}
