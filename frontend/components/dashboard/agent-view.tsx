'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

import { ChatView } from '@/components/dashboard/chat-view'
import { DashboardPage } from '@/components/dashboard/shared/dashboard-page'
import { WorkspaceAssistantChannelsTab } from '@/components/dashboard/settings/workspace-assistant-channels-tab'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  buildDashboardHref,
  type AgentTab,
  type DashboardRouteState,
} from '@/lib/dashboard-routes'
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
  const activeTab = routeState.agentTab ?? 'chat'
  const [saveState, setSaveState] = useState<{
    state: 'idle' | 'saved' | 'saving' | 'error'
    message?: string | null
  }>({ state: 'idle' })

  const tabNavigation = (
    <TabsList>
      <TabsTrigger value="chat">Chat</TabsTrigger>
      <TabsTrigger value="behavior">Behavior</TabsTrigger>
      <TabsTrigger value="channels">Channels</TabsTrigger>
    </TabsList>
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
        <ChatView
          accountId={accountId}
          onOpenDocument={onOpenDocument}
          onboarding={onboarding}
          navigation={tabNavigation}
        />
      </TabsContent>

      <TabsContent value="behavior" className="min-h-0 flex flex-1 flex-col overflow-hidden">
        <DashboardPage
          title="Agent"
          description={agentTabSummaries.behavior}
          titleAccessory={saveStateAccessory}
          actions={tabNavigation}
          contentClassName="flex flex-col overflow-hidden p-0"
          contentScroll={false}
        >
          <WorkspaceAssistantChannelsTab accountId={accountId} mode="assistant" onSaveStateChange={setSaveState} />
        </DashboardPage>
      </TabsContent>

      <TabsContent value="channels" className="min-h-0 flex flex-1 flex-col overflow-hidden">
        <DashboardPage
          title="Agent"
          description={agentTabSummaries.channels}
          titleAccessory={saveStateAccessory}
          actions={tabNavigation}
          contentClassName="flex flex-col overflow-hidden p-0"
          contentScroll={false}
        >
          <WorkspaceAssistantChannelsTab accountId={accountId} mode="channels" onSaveStateChange={setSaveState} />
        </DashboardPage>
      </TabsContent>
    </Tabs>
  )
}
