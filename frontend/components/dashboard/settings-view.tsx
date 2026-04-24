'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

import { ConnectorsTab } from '@/components/dashboard/connectors/connectors-tab'
import { GeneralTab } from '@/components/dashboard/settings/general-tab'
import { IngestionSettingsPanel } from '@/components/dashboard/settings/ingestion-settings-panel'
import { RetrievalSettingsPanel } from '@/components/dashboard/settings/retrieval-settings-panel'
import { SettingsTabShell } from '@/components/dashboard/settings/settings-tab-shell'
import { getSettingsTabDescriptor } from '@/components/dashboard/settings/settings-tab-metadata'
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
  const activeTab = routeState.settingsTab ?? 'general'
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
            connectorId: value === 'connectors' ? routeState.connectorId : undefined,
          }))
        }}
        className="flex flex-1 flex-col"
      >
        <div className="sticky top-0 z-20 border-b border-border bg-background/95 px-6 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/80">
          <div className="flex items-center justify-between gap-4">
            <TabsList>
              <TabsTrigger value="general">General</TabsTrigger>
              <TabsTrigger value="ingestion">Ingestion</TabsTrigger>
              <TabsTrigger value="retrieval">Retrieval</TabsTrigger>
              <TabsTrigger value="connectors">Chat Connectors</TabsTrigger>
            </TabsList>
            {activeTab === 'general' ? (
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
        </div>

        <TabsContent value="general" className="flex-1 overflow-hidden">
          <GeneralTab accountId={accountId} routeState={routeState} onSaveStateChange={setGeneralSaveState} />
        </TabsContent>

        <TabsContent value="ingestion" className="flex-1 overflow-hidden">
          <IngestionSettingsPanel
            accountId={accountId}
            routeState={routeState}
            onSaveStateChange={setIngestionSaveState}
          />
        </TabsContent>

        <TabsContent value="retrieval" className="flex-1 overflow-hidden">
          <RetrievalSettingsPanel
            accountId={accountId}
            routeState={routeState}
            onSaveStateChange={setRetrievalSaveState}
          />
        </TabsContent>

        <TabsContent value="connectors" className="flex-1 overflow-hidden">
          <SettingsTabShell
            accountId={accountId}
            routeState={routeState}
            descriptor={getSettingsTabDescriptor('connectors')}
            onNavigate={(href) => router.push(href)}
            showSidebar={false}
          >
            <div id="connectors" className="mx-auto max-w-5xl scroll-mt-24">
              <ConnectorsTab accountId={accountId} routeState={routeState} />
            </div>
          </SettingsTabShell>
        </TabsContent>
      </Tabs>
    </div>
  )
}
