'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

import { DashboardPage } from '@/components/dashboard/shared/dashboard-page'
import { SaveStateIndicator } from '@/components/dashboard/shared/save-state-indicator'
import { ProvidersPanel } from '@/components/dashboard/settings/providers-panel'
import { WorkspaceAssistantChannelsTab } from '@/components/dashboard/settings/workspace-assistant-channels-tab'
import { buildDashboardHref, type DashboardRouteState } from '@/lib/dashboard-routes'

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

  const saveStateAccessory = <SaveStateIndicator saveState={saveState} />

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
    <DashboardPage
      title={activeTab === 'providers' ? 'Providers' : 'Workspace'}
      titleAccessory={saveStateAccessory}
      contentClassName="flex flex-col overflow-hidden p-0"
      contentScroll={false}
    >
      {activeTab === 'providers' ? (
        <ProvidersPanel onSaveStateChange={setSaveState} />
      ) : (
        <WorkspaceAssistantChannelsTab accountId={accountId} mode="workspace" onSaveStateChange={setSaveState} />
      )}
    </DashboardPage>
  )
}
