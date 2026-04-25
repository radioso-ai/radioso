'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

import { IngestionSettingsPanel } from '@/components/dashboard/settings/ingestion-settings-panel'
import { RetrievalSettingsPanel } from '@/components/dashboard/settings/retrieval-settings-panel'
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
    <div className="flex h-full flex-col">
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
        className="flex flex-1 flex-col"
      >
        <div className="sticky top-0 z-20 border-b border-border bg-background/95 py-4 backdrop-blur supports-[backdrop-filter]:bg-background/80">
          <div className="flex w-full flex-col gap-3 px-4 sm:px-6">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0">
                <div className="flex items-center gap-3">
                  <h1 className="text-lg font-medium text-foreground">Settings</h1>
                  {activeTab === 'workspace' || activeTab === 'assistant' || activeTab === 'channels' ? (
                    <div className="text-sm">
                      {generalSaveState.state === 'saving' ? (
                        <span className="text-muted-foreground">Saving…</span>
                      ) : generalSaveState.state === 'error' ? (
                        <span className="text-destructive">
                          {generalSaveState.message ?? 'Failed to save changes'}
                        </span>
                      ) : generalSaveState.state === 'saved' ? (
                        <span className="text-muted-foreground">Saved</span>
                      ) : null}
                    </div>
                  ) : activeTab === 'retrieval' ? (
                    <div className="text-sm">
                      {retrievalSaveState.state === 'saving' ? (
                        <span className="text-muted-foreground">Saving…</span>
                      ) : retrievalSaveState.state === 'error' ? (
                        <span className="text-destructive">
                          {retrievalSaveState.message ?? 'Failed to save changes'}
                        </span>
                      ) : retrievalSaveState.state === 'saved' ? (
                        <span className="text-muted-foreground">Saved</span>
                      ) : null}
                    </div>
                  ) : activeTab === 'ingestion' ? (
                    <div className="text-sm">
                      {ingestionSaveState.state === 'saving' ? (
                        <span className="text-muted-foreground">Saving…</span>
                      ) : ingestionSaveState.state === 'error' ? (
                        <span className="text-destructive">
                          {ingestionSaveState.message ?? 'Failed to save changes'}
                        </span>
                      ) : ingestionSaveState.state === 'saved' ? (
                        <span className="text-muted-foreground">Saved</span>
                      ) : null}
                    </div>
                  ) : null}
                </div>
                <p className="mt-1 text-sm text-muted-foreground">{activeTabDescriptor.summary}</p>
              </div>
              <div className="lg:ml-auto lg:self-start">
                <TabsList>
                  <TabsTrigger value="workspace">Workspace</TabsTrigger>
                  <TabsTrigger value="assistant">Assistant</TabsTrigger>
                  <TabsTrigger value="channels">Channels</TabsTrigger>
                  <TabsTrigger value="ingestion">Ingestion</TabsTrigger>
                  <TabsTrigger value="retrieval">Retrieval</TabsTrigger>
                </TabsList>
              </div>
            </div>
          </div>
        </div>

        <TabsContent value="workspace" className="flex-1 overflow-hidden">
          <WorkspaceAssistantChannelsTab accountId={accountId} mode="workspace" onSaveStateChange={setGeneralSaveState} />
        </TabsContent>

        <TabsContent value="assistant" className="flex-1 overflow-hidden">
          <WorkspaceAssistantChannelsTab accountId={accountId} mode="assistant" onSaveStateChange={setGeneralSaveState} />
        </TabsContent>

        <TabsContent value="channels" className="flex-1 overflow-hidden">
          <WorkspaceAssistantChannelsTab accountId={accountId} mode="channels" onSaveStateChange={setGeneralSaveState} />
        </TabsContent>

        <TabsContent value="ingestion" className="flex-1 overflow-hidden">
          <IngestionSettingsPanel onSaveStateChange={setIngestionSaveState} />
        </TabsContent>

        <TabsContent value="retrieval" className="flex-1 overflow-hidden">
          <RetrievalSettingsPanel onSaveStateChange={setRetrievalSaveState} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
