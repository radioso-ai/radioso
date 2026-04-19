'use client'

import { useEffect } from 'react'
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
  const activeDescriptor = getSettingsTabDescriptor(activeTab)

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
      <div className="border-b border-border px-6 py-4">
        <h1 className="text-lg font-medium text-foreground">Settings</h1>
        <p className="text-sm text-muted-foreground">
          {activeDescriptor.summary}
        </p>
      </div>

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
        <div className="border-b border-border px-6 py-3">
          <TabsList>
            <TabsTrigger value="general">General</TabsTrigger>
            <TabsTrigger value="ingestion">Ingestion</TabsTrigger>
            <TabsTrigger value="retrieval">Retrieval</TabsTrigger>
            <TabsTrigger value="connectors">Chat Connectors</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="general" className="flex-1 overflow-hidden">
          <GeneralTab accountId={accountId} routeState={routeState} />
        </TabsContent>

        <TabsContent value="ingestion" className="flex-1 overflow-hidden">
          <IngestionSettingsPanel accountId={accountId} routeState={routeState} />
        </TabsContent>

        <TabsContent value="retrieval" className="flex-1 overflow-hidden">
          <RetrievalSettingsPanel accountId={accountId} routeState={routeState} />
        </TabsContent>

        <TabsContent value="connectors" className="flex-1 overflow-hidden">
          <SettingsTabShell
            accountId={accountId}
            routeState={routeState}
            descriptor={getSettingsTabDescriptor('connectors')}
            onNavigate={(href) => router.push(href)}
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
