'use client'

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Globe2, RefreshCw, X } from 'lucide-react'

import { ChatView } from '@/components/dashboard/chat-view'
import { DashboardPage } from '@/components/dashboard/shared/dashboard-page'
import { SaveStateIndicator } from '@/components/dashboard/shared/save-state-indicator'
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
import {
  clearAgentCreationHandoff as rawClearAgentCreationHandoff,
  readAgentCreationHandoff as rawReadAgentCreationHandoff,
  WizardDialog as RawWizardDialog,
} from '@/lib/agent-creation-contributions'
import {
  loadAgentCreationActionDefinitions,
  resolveAgentCreationActions,
  type AgentCreationActionDefinition,
} from '@/lib/agent-creation-extensions'
import { editionController } from '@/lib/edition-controller'
import { useWorkspace } from '@/lib/workspace-context'
import { type WorkspaceOnboardingState } from '@/lib/onboarding'

type WizardDialogComponent = (props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  agentSettingsHrefBuilder: (agentId: string) => string
}) => React.ReactElement | null
interface AgentCreationHandoffItem {
  title: string | null
  url: string
}

interface AgentCreationHandoff {
  agentId: string
  title: string
  description: string
  items: AgentCreationHandoffItem[]
  createdAt: number
}

type ReadAgentCreationHandoff = (agentId: string | undefined) => AgentCreationHandoff | null
const agentCreationExtensionsEnabled = editionController.canUseAgentCreationExtensions()
const WizardDialog = agentCreationExtensionsEnabled
  ? RawWizardDialog as unknown as WizardDialogComponent | null
  : null
const readAgentCreationHandoff: ReadAgentCreationHandoff = agentCreationExtensionsEnabled
  ? rawReadAgentCreationHandoff as ReadAgentCreationHandoff
  : () => null
const clearAgentCreationHandoff: () => void = agentCreationExtensionsEnabled
  ? rawClearAgentCreationHandoff as () => void
  : () => {}

const agentTabSummaries: Record<AgentTab, string> = {
  chat: 'Test the selected agent against this workspace knowledge.',
  behavior: 'Identity, behavior, and escalation for the selected agent.',
  channels: 'Where users can access this agent.',
}

function AgentCreationHandoffBanner({
  summary,
  onDismiss,
}: {
  summary: AgentCreationHandoff
  onDismiss: () => void
}) {
  return (
    <div className="border-b border-border bg-background px-4 py-3 sm:px-6">
      <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 space-y-3">
            <div>
              <p className="text-sm font-medium">{summary.title}</p>
              <p className="mt-1 truncate text-sm text-muted-foreground">{summary.description}</p>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-primary" style={{ width: '100%' }} />
            </div>
            {summary.items.length > 0 ? (
              <div className="grid gap-2 sm:grid-cols-2">
                {summary.items.slice(0, 6).map((item, index) => (
                  <div key={`${item.url}-${index}`} className="min-w-0 rounded-md bg-muted/40 px-3 py-2">
                    <p className="truncate text-xs font-medium">{item.title || 'Untitled page'}</p>
                    <p className="truncate text-xs text-muted-foreground">{item.url}</p>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
          <Button type="button" variant="ghost" size="icon" onClick={onDismiss} aria-label="Dismiss agent creation summary">
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  )
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
  const { activeWorkspace, activeWorkspaceId } = useWorkspace()
  const activeTab = routeState.agentTab ?? 'chat'
  const [agents, setAgents] = useState<AgentSettings[]>([])
  const [agentsError, setAgentsError] = useState<string | null>(null)
  const [isAgentsLoading, setIsAgentsLoading] = useState(true)
  const [saveState, setSaveState] = useState<{
    state: 'idle' | 'saved' | 'saving' | 'error'
    message?: string | null
  }>({ state: 'idle' })
  const [agentCreationHandoff, setAgentCreationHandoff] = useState<AgentCreationHandoff | null>(null)
  const [agentCreationActionDefinitions, setAgentCreationActionDefinitions] = useState<AgentCreationActionDefinition[]>([])
  const [wizardOpen, setWizardOpen] = useState(false)
  const agentCreationActions = useMemo(
    () => agentCreationExtensionsEnabled
      ? resolveAgentCreationActions(agentCreationActionDefinitions, {
        accountId,
        workspacePublicRouteKey: activeWorkspace?.publicRouteKey,
      })
      : [],
    [accountId, agentCreationActionDefinitions, activeWorkspace?.publicRouteKey],
  )

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
    if (!agentCreationExtensionsEnabled) {
      return
    }

    let active = true
    void loadAgentCreationActionDefinitions().then((definitions) => {
      if (active) {
        setAgentCreationActionDefinitions(definitions)
      }
    })
    return () => {
      active = false
    }
  }, [])

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

  const channelsTabHref = useMemo(
    () =>
      buildDashboardHref(accountId, {
        ...routeState,
        section: 'agents',
        agentTab: 'channels',
        anchor: undefined,
      }),
    [accountId, routeState],
  )

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
  const isAgentRouteCanonicalizing = Boolean(
    !isAgentsLoading &&
    !agentsError &&
    selectedAgentId &&
    routeState.agentId !== selectedAgentId,
  )
  const agentSelectionPending = isAgentsLoading || isAgentRouteCanonicalizing
  const agentSelectionUnavailable = Boolean(!isAgentsLoading && (agentsError || !selectedAgent))

  useEffect(() => {
    if (selectedAgentId) {
      setLastSelectedAgentId(activeWorkspaceId, selectedAgentId)
    }
  }, [activeWorkspaceId, selectedAgentId])

  useEffect(() => {
    if (!agentCreationExtensionsEnabled) {
      return
    }

    const timeout = window.setTimeout(() => {
      setAgentCreationHandoff(readAgentCreationHandoff(selectedAgentId))
    }, 0)

    return () => window.clearTimeout(timeout)
  }, [selectedAgentId])

  const dismissAgentCreationHandoff = useCallback(() => {
    clearAgentCreationHandoff()
    setAgentCreationHandoff(null)
  }, [])

  useEffect(() => {
    if (isAgentsLoading || agentsError || !selectedAgentId || routeState.agentId === selectedAgentId) {
      return
    }

    router.replace(buildDashboardHref(accountId, {
      ...routeState,
      section: 'agents',
      agentId: selectedAgentId,
      anchor: undefined,
    }))
  }, [accountId, agentsError, isAgentsLoading, routeState, router, selectedAgentId])

  const tabNavigation = (
    <div className="flex flex-wrap items-center gap-2">
      <TabsList>
        <TabsTrigger value="chat">Chat</TabsTrigger>
        <TabsTrigger value="behavior">Assistant</TabsTrigger>
        <TabsTrigger value="channels">Channels</TabsTrigger>
      </TabsList>
    </div>
  )

  const saveStateAccessory = <SaveStateIndicator saveState={saveState} />

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
  ) : agents.length === 0 ? (
    <div className="flex min-h-64 flex-col items-start justify-center gap-4 p-6">
      <div className="max-w-xl">
        <p className="font-medium text-foreground">Create your first agent</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Add an agent with its own identity, instructions, and channel settings.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {agentCreationActions.map((action) => (
          <Button
            key={action.id}
            type="button"
            onClick={() => {
              if (action.kind === 'wizard-dialog' && WizardDialog) {
                setWizardOpen(true)
              } else if (action.href) {
                router.push(action.href)
              }
            }}
          >
            <Globe2 className="mr-2 h-4 w-4" />
            {action.label}
          </Button>
        ))}
      </div>
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
            {agentCreationHandoff ? (
              <AgentCreationHandoffBanner
                summary={agentCreationHandoff}
                onDismiss={dismissAgentCreationHandoff}
              />
            ) : null}
            <WorkspaceAssistantChannelsTab accountId={accountId} mode="assistant" agentId={selectedAgentId} channelsTabHref={channelsTabHref} onSaveStateChange={setSaveState} />
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
      {WizardDialog ? (
        <WizardDialog
          open={wizardOpen}
          onOpenChange={setWizardOpen}
          agentSettingsHrefBuilder={(agentId) =>
            buildDashboardHref(accountId, {
              section: 'agents',
              agentId,
              agentTab: 'behavior',
              anchor: 'assistant-identity',
              workspaceId: activeWorkspaceId ?? undefined,
              workspacePublicRouteKey: activeWorkspace?.publicRouteKey ?? undefined,
            })
          }
        />
      ) : null}
    </Tabs>
  )
}
