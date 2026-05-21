'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

import { DashboardPage } from '@/components/dashboard/shared/dashboard-page'
import { ProvidersPanel } from '@/components/dashboard/settings/providers-panel'
import { WorkspaceAssistantChannelsTab } from '@/components/dashboard/settings/workspace-assistant-channels-tab'
import { UsersPanel } from '@/components/dashboard/users-view'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  buildDashboardHref,
  type DashboardRouteState,
  type SettingsTab,
} from '@/lib/dashboard-routes'

const settingsTabSummaries: Record<SettingsTab, string> = {
  workspace: 'Control workspace identity, API access, and lifecycle.',
  providers: 'Connect AI provider API keys and pick which model handles chat, query rewrite, and rerank.',
  users: 'Invite teammates and manage account access.',
}

export function SettingsView({
  accountId,
  routeState,
}: {
  accountId: string
  routeState: DashboardRouteState
}) {
  const router = useRouter()
  const activeTab = routeState.settingsTab ?? 'workspace'
  const [saveState, setSaveState] = useState<{
    state: 'idle' | 'saved' | 'saving' | 'error'
    message?: string | null
  }>({ state: 'idle' })

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
        section: 'settings',
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
          section: 'settings',
          settingsTab: value as SettingsTab,
          anchor: undefined,
        }))
      }}
      className="h-full min-h-0 gap-0"
    >
      <DashboardPage
        title="Settings"
        description={settingsTabSummaries[activeTab]}
        titleAccessory={activeTab === 'workspace' || activeTab === 'providers' ? saveStateAccessory : null}
        actions={
          <TabsList>
            <TabsTrigger value="workspace">Workspace</TabsTrigger>
            <TabsTrigger value="providers">Providers</TabsTrigger>
            <TabsTrigger value="users">Users</TabsTrigger>
          </TabsList>
        }
        actionsClassName="xl:self-start"
        contentClassName="flex flex-col overflow-hidden p-0"
        contentScroll={false}
      >
        <TabsContent value="workspace" className="min-h-0 flex flex-1 flex-col overflow-hidden">
          <WorkspaceAssistantChannelsTab accountId={accountId} mode="workspace" onSaveStateChange={setSaveState} />
        </TabsContent>

        <TabsContent value="providers" className="min-h-0 flex flex-1 flex-col overflow-hidden">
          <ProvidersPanel onSaveStateChange={setSaveState} />
        </TabsContent>

        <TabsContent value="users" className="settings-surface min-h-0 flex-1 overflow-y-auto">
          <div className="w-full p-6">
            <UsersPanel />
          </div>
        </TabsContent>
      </DashboardPage>
    </Tabs>
  )
}
