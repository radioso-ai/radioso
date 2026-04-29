'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

import { IngestionSettingsPanel } from '@/components/dashboard/settings/ingestion-settings-panel'
import { RetrievalSettingsPanel } from '@/components/dashboard/settings/retrieval-settings-panel'
import { DashboardPage } from '@/components/dashboard/shared/dashboard-page'
import { getSettingsTabDescriptor } from '@/components/dashboard/settings/settings-tab-metadata'
import { WorkspaceAssistantChannelsTab } from '@/components/dashboard/settings/workspace-assistant-channels-tab'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  buildDashboardHref,
  type DashboardRouteState,
  type SettingsTab,
} from '@/lib/dashboard-routes'

export function SettingsView({
  accountId,
  routeState,
}: {
  accountId: string
  routeState: DashboardRouteState
}) {
  const router = useRouter()
  const activeTab = routeState.settingsTab ?? 'workspace'
  const activeTabDescriptor = getSettingsTabDescriptor(activeTab)
  const [retrievalSaveState, setRetrievalSaveState] = useState<{
    state: 'idle' | 'saved' | 'saving' | 'error'
    message?: string | null
  }>({ state: 'idle' })
  const [ingestionSaveState, setIngestionSaveState] = useState<{
    state: 'idle' | 'saved' | 'saving' | 'error'
    message?: string | null
  }>({ state: 'idle' })
  const [generalSaveState, setGeneralSaveState] = useState<{
    state: 'idle' | 'saved' | 'saving' | 'error'
    message?: string | null
  }>({ state: 'idle' })
  const activeSaveState =
    activeTab === 'workspace' || activeTab === 'assistant' || activeTab === 'channels'
      ? generalSaveState
      : activeTab === 'retrieval'
        ? retrievalSaveState
        : activeTab === 'ingestion'
          ? ingestionSaveState
          : { state: 'idle' as const }
  const saveStateAccessory = (
    <div className="text-sm">
      {activeSaveState.state === 'saving' ? (
        <span className="text-muted-foreground">Saving…</span>
      ) : activeSaveState.state === 'error' ? (
        <span className="text-destructive">
          {activeSaveState.message ?? 'Failed to save changes'}
        </span>
      ) : activeSaveState.state === 'saved' ? (
        <span className="text-muted-foreground">Saved</span>
      ) : null}
    </div>
  )

  useEffect(() => {
    if (!routeState.settingsAnchor) {
      return
    }

    const element = document.getElementById(routeState.settingsAnchor)
    if (!element) {
      router.replace(buildDashboardHref(accountId, {
        ...routeState,
        section: 'settings',
        settingsAnchor: undefined,
      }))
      return
    }

    element.scrollIntoView({ block: 'start', behavior: 'auto' })
  }, [accountId, routeState, router])

  return (
    <Tabs
      value={activeTab}
      onValueChange={(value) => {
        router.push(buildDashboardHref(accountId, {
          ...routeState,
          section: 'settings',
          settingsTab: value as SettingsTab,
          settingsAnchor: undefined,
        }))
      }}
      className="h-full min-h-0 gap-0"
    >
      <DashboardPage
        title="Settings"
        description={activeTabDescriptor.summary}
        titleAccessory={saveStateAccessory}
        actions={
          <TabsList>
            <TabsTrigger value="workspace">Workspace</TabsTrigger>
            <TabsTrigger value="assistant">Assistant</TabsTrigger>
            <TabsTrigger value="channels">Channels</TabsTrigger>
            <TabsTrigger value="ingestion">Ingestion</TabsTrigger>
            <TabsTrigger value="retrieval">Retrieval</TabsTrigger>
          </TabsList>
        }
        actionsClassName="xl:self-start"
        contentClassName="flex flex-col overflow-hidden p-0"
        contentScroll={false}
      >

        <TabsContent value="workspace" className="min-h-0 flex flex-1 flex-col overflow-hidden">
          <WorkspaceAssistantChannelsTab accountId={accountId} mode="workspace" onSaveStateChange={setGeneralSaveState} />
        </TabsContent>

        <TabsContent value="assistant" className="min-h-0 flex flex-1 flex-col overflow-hidden">
          <WorkspaceAssistantChannelsTab accountId={accountId} mode="assistant" onSaveStateChange={setGeneralSaveState} />
        </TabsContent>

        <TabsContent value="channels" className="min-h-0 flex flex-1 flex-col overflow-hidden">
          <WorkspaceAssistantChannelsTab accountId={accountId} mode="channels" onSaveStateChange={setGeneralSaveState} />
        </TabsContent>

        <TabsContent value="ingestion" className="min-h-0 flex flex-1 flex-col overflow-hidden">
          <IngestionSettingsPanel onSaveStateChange={setIngestionSaveState} />
        </TabsContent>

        <TabsContent value="retrieval" className="min-h-0 flex flex-1 flex-col overflow-hidden">
          <RetrievalSettingsPanel onSaveStateChange={setRetrievalSaveState} />
        </TabsContent>
      </DashboardPage>
    </Tabs>
  )
}
