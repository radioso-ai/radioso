'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

import { DashboardPage } from '@/components/dashboard/shared/dashboard-page'
import { SaveStateIndicator } from '@/components/dashboard/shared/save-state-indicator'
import { ProvidersPanel } from '@/components/dashboard/settings/providers-panel'
import { ApiAccessPanel } from '@/components/dashboard/settings/api-access-panel'
import { getSettingsSectionDescriptor } from '@/components/dashboard/settings/settings-tab-metadata'
import { SettingsTabShell } from '@/components/dashboard/settings/settings-tab-shell'
import { WorkspaceAssistantChannelsTab } from '@/components/dashboard/settings/workspace-assistant-channels-tab'
import { buildDashboardHref, type DashboardRouteState } from '@/lib/dashboard-routes'
import { useWorkspace } from '@/lib/workspace-context'

export function SettingsView({
  accountId,
  routeState,
}: {
  accountId: string
  routeState: DashboardRouteState
}) {
  const router = useRouter()
  const { activeWorkspaceId } = useWorkspace()
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

    const scrollToAnchor = () => {
      const element = document.getElementById(routeState.anchor!)
      if (!element) return false
      element.scrollIntoView({ block: 'start', behavior: 'auto' })
      return true
    }

    if (scrollToAnchor()) {
      return
    }

    const clearAnchor = () => {
      router.replace(buildDashboardHref(accountId, {
        ...routeState,
        section: 'settings',
        anchor: undefined,
      }))
    }

    if (getSettingsSectionDescriptor(activeTab, routeState.anchor)) {
      const isWaitingForSections = () => {
        if (activeTab !== 'api-access' || !activeWorkspaceId) return false
        return document.getElementById('api-access')?.dataset.settingsSectionState === 'loading'
      }

      if (!isWaitingForSections()) {
        clearAnchor()
        return
      }

      const observer = new MutationObserver(() => {
        if (scrollToAnchor()) {
          observer.disconnect()
          return
        }
        if (!isWaitingForSections()) {
          observer.disconnect()
          clearAnchor()
        }
      })
      observer.observe(document.body, { childList: true, subtree: true })
      return () => observer.disconnect()
    }

    const element = document.getElementById(routeState.anchor)
    if (!element) {
      clearAnchor()
    }
  }, [accountId, activeTab, activeWorkspaceId, routeState, router])

  return (
    <DashboardPage
      title={activeTab === 'providers' ? 'Providers' : activeTab === 'api-access' ? 'API access' : 'Workspace'}
      titleAccessory={saveStateAccessory}
      contentClassName="flex flex-col overflow-hidden p-0"
      contentScroll={false}
    >
      {activeTab === 'providers' ? (
        <ProvidersPanel onSaveStateChange={setSaveState} />
      ) : activeTab === 'api-access' ? (
        <SettingsTabShell>
          <ApiAccessPanel key={activeWorkspaceId ?? 'none'} workspaceId={activeWorkspaceId} />
        </SettingsTabShell>
      ) : (
        <WorkspaceAssistantChannelsTab accountId={accountId} mode="workspace" onSaveStateChange={setSaveState} />
      )}
    </DashboardPage>
  )
}
