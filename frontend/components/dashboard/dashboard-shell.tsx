'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar'
import { AppSidebar } from './app-sidebar'
import { AgentSubNavContainer } from './agent-subnav-container'
import { ActivitySubNav, KnowledgeSubNav, SettingsSubNav } from './area-subnavs'
import { AgentView } from './agent-view'
import { AccountView } from './account-view'
import { ChatHistoryView } from './chat-history-view'
import { NeedsAttentionView } from './needs-attention-view'
import { KnowledgeView } from './knowledge-view'
import { SettingsView } from './settings-view'
import { QualityView } from './quality-view'
import { AudiencePulseView } from './audience-pulse-view'
import { EvalView } from './eval-view'
import { CopilotView } from './copilot-view'
import { AskRayInput, CopilotPanel, CopilotSelectionAffordance } from './copilot-panel'
import { FirstRunExperience } from './first-run-experience'
import {
  buildDashboardHref,
  retargetDashboardRouteToWorkspace,
  type DashboardRouteState,
} from '@/lib/dashboard-routes'
import { activeArea } from '@/lib/dashboard-areas'
import {
  shouldRewriteToActiveWorkspace,
  shouldWaitForRouteWorkspace,
} from '@/lib/dashboard-workspace-sync'
import { useWorkspace } from '@/lib/workspace-context'
import { useWorkspaceOnboarding } from '@/lib/onboarding'
import { LogoSpinner } from '@/components/ui/spinner'
import { copilotApi, isCopilotApiErrorStatus, type CopilotAvailability } from '@/lib/api-copilot'
import { CopilotContextProvider } from '@/lib/copilot-context'

interface DashboardShellProps {
  accountId: string
  routeState: DashboardRouteState
}

export function DashboardShell({
  accountId,
  routeState,
}: DashboardShellProps) {
  const router = useRouter()
  const routeWorkspaceSyncKeyRef = useRef<string | null>(null)
  const pendingRouteWorkspaceIdRef = useRef<string | null>(null)
  const { activeWorkspaceId, workspaces, isLoading: isWorkspaceLoading, switchWorkspace } = useWorkspace()
  const [copilotAvailability, setCopilotAvailability] = useState<CopilotAvailability | null>(null)
  const [copilotPermissionDenied, setCopilotPermissionDenied] = useState(false)
  const onboarding = useWorkspaceOnboarding(activeWorkspaceId, workspaces.length)
  const requestedWorkspaceId = routeState.workspaceId
  const requestedWorkspaceExists = requestedWorkspaceId
    ? workspaces.some((workspace) => workspace.id === requestedWorkspaceId)
    : false
  const activeWorkspacePublicRouteKey = activeWorkspaceId
    ? workspaces.find((workspace) => workspace.id === activeWorkspaceId)?.publicRouteKey
    : undefined
  const currentView = routeState.section
  const isAgentChatView = currentView === 'agents' && (routeState.agentTab ?? 'chat') === 'chat'
  // The labeled sidebar is the single nav surface: the active section's sub-nav
  // nests under its rail row instead of occupying a second column. The first-run
  // takeover still shows full-width content.
  const showFirstRun = isAgentChatView && onboarding.shouldShowFirstRun
  const area = activeArea(routeState)
  const hasSubNav = area !== null && !showFirstRun

  useEffect(() => {
    if (!activeWorkspaceId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Reset workspace-scoped Copilot access before loading the next workspace.
      setCopilotAvailability(null)
      setCopilotPermissionDenied(false)
      return
    }

    const controller = new AbortController()
    setCopilotAvailability(null)
    setCopilotPermissionDenied(false)
    void copilotApi.getAvailability(controller.signal)
      .then((availability) => setCopilotAvailability(availability))
      .catch((error: unknown) => {
        if (isCopilotApiErrorStatus(error, 403)) {
          setCopilotPermissionDenied(true)
        }
      })

    return () => controller.abort()
  }, [activeWorkspaceId])

  useEffect(() => {
    const syncKey = requestedWorkspaceExists ? (requestedWorkspaceId ?? null) : null
    if (routeWorkspaceSyncKeyRef.current === syncKey) {
      return
    }

    routeWorkspaceSyncKeyRef.current = syncKey

    if (!requestedWorkspaceId || !requestedWorkspaceExists || activeWorkspaceId === requestedWorkspaceId) {
      pendingRouteWorkspaceIdRef.current = null
      return
    }

    pendingRouteWorkspaceIdRef.current = requestedWorkspaceId
    void switchWorkspace(requestedWorkspaceId)
  }, [activeWorkspaceId, requestedWorkspaceExists, requestedWorkspaceId, switchWorkspace])

  useEffect(() => {
    if (!activeWorkspaceId) {
      return
    }

    const pendingRouteWorkspaceId = pendingRouteWorkspaceIdRef.current
    if (pendingRouteWorkspaceId && activeWorkspaceId === pendingRouteWorkspaceId) {
      pendingRouteWorkspaceIdRef.current = null
    }

    if (
      pendingRouteWorkspaceId &&
      requestedWorkspaceId === pendingRouteWorkspaceId &&
      requestedWorkspaceExists &&
      requestedWorkspaceId !== activeWorkspaceId
    ) {
      return
    }

    if (!shouldRewriteToActiveWorkspace({
      activeWorkspaceId,
      requestedWorkspaceExists,
      requestedWorkspaceId,
    })) {
      return
    }

    router.replace(buildDashboardHref(
      accountId,
      retargetDashboardRouteToWorkspace(routeState, activeWorkspaceId, activeWorkspacePublicRouteKey),
    ))
  }, [
    accountId,
    activeWorkspaceId,
    activeWorkspacePublicRouteKey,
    requestedWorkspaceExists,
    requestedWorkspaceId,
    routeState,
    router,
  ])

  // Memoized so consumers relying on identity stability (e.g. useEffect deps in
  // documents-view's selected-document sync) do not re-run on every parent render.
  const openDocument = useCallback((documentId: string | null) => {
    router.push(buildDashboardHref(accountId, {
      ...routeState,
      section: 'knowledge',
      knowledgeTab: 'documents',
      documentId: documentId ?? undefined,
      workspaceId: activeWorkspaceId ?? undefined,
      workspacePublicRouteKey: activeWorkspacePublicRouteKey,
    }))
  }, [accountId, activeWorkspaceId, activeWorkspacePublicRouteKey, routeState, router])

  if (
    isWorkspaceLoading ||
    (isAgentChatView && onboarding.isLoading) ||
    shouldWaitForRouteWorkspace({
      activeWorkspaceId,
      requestedWorkspaceExists,
      requestedWorkspaceId,
    })
  ) {
    return (
      <CopilotContextProvider key={activeWorkspaceId ?? 'workspace-loading'}>
        <SidebarProvider open onOpenChange={() => {}} className="h-svh min-h-0 overflow-hidden">
          <AppSidebar
            accountId={accountId}
            currentView={currentView}
            routeState={routeState}
            askRaySlot={copilotPermissionDenied ? null : <AskRayInput />}
          />
          <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
            {/* Mobile-only chrome: the desktop sidebar is pinned open (single nav
                surface), so this top strip only exists on mobile, where the nav is
                offcanvas and needs a trigger to open it. Ask Ray lives in the sidebar. */}
            <header className="sticky top-0 z-40 flex h-12 shrink-0 items-center border-b border-border bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/80 md:hidden">
              <SidebarTrigger />
            </header>
            <div className="flex min-h-0 flex-1 items-center justify-center">
              <LogoSpinner imageClassName="h-7 w-7" />
            </div>
          </SidebarInset>
        </SidebarProvider>
      </CopilotContextProvider>
    )
  }

  // The active section's sub-nav renders in exactly one place — nested inside the
  // sidebar, under its rail row (desktop column and mobile drawer share it).
  // Computing it once keeps stateful containers (e.g. the agent switcher) from
  // mounting twice.
  const subNav = showFirstRun ? null : area === 'agents' ? (
    <AgentSubNavContainer accountId={accountId} routeState={routeState} />
  ) : area === 'knowledge' ? (
    <KnowledgeSubNav accountId={accountId} routeState={routeState} />
  ) : area === 'settings' ? (
    <SettingsSubNav accountId={accountId} routeState={routeState} />
  ) : currentView === 'activity' || currentView === 'quality' ? (
    // Activity/Quality have no content "area", but their views (Needs attention / All
    // activity / Quality) are now sidebar items nested under the Activity rail row.
    <ActivitySubNav accountId={accountId} routeState={routeState} />
  ) : null

  const areaContent = area === 'agents' ? (
    <AgentView accountId={accountId} routeState={routeState} onboarding={onboarding} onOpenDocument={openDocument} />
  ) : area === 'knowledge' ? (
    <KnowledgeView
      routeState={routeState}
      accountId={accountId}
      selectedDocumentId={routeState.documentId ?? null}
      onSelectedDocumentChange={openDocument}
      onboarding={onboarding}
    />
  ) : area === 'settings' ? (
    <SettingsView accountId={accountId} routeState={routeState} />
  ) : (
    <AccountView accountId={accountId} routeState={routeState} />
  )

  return (
    <CopilotContextProvider key={activeWorkspaceId ?? 'workspace-loading'}>
      <SidebarProvider open onOpenChange={() => {}} className="h-svh min-h-0 overflow-hidden">
        <AppSidebar
          accountId={accountId}
          currentView={currentView}
          routeState={routeState}
          areaSubNav={subNav}
          askRaySlot={copilotPermissionDenied ? null : <AskRayInput />}
        />
        <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
          {/* Mobile-only chrome: the desktop sidebar is pinned open (single nav
              surface), so this top strip only exists on mobile, where the nav is
              offcanvas and needs a trigger to open it. Ask Ray lives in the sidebar. */}
          <header className="sticky top-0 z-40 flex h-12 shrink-0 items-center border-b border-border bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/80 md:hidden">
            <SidebarTrigger />
          </header>
          <div key={activeWorkspaceId} data-dashboard-surface className="flex min-h-0 flex-1 flex-col">
          {showFirstRun ? (
            <FirstRunExperience accountId={accountId} onboarding={onboarding} />
          ) : hasSubNav ? (
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">{areaContent}</div>
          ) : currentView === 'activity' ? (
            routeState.activityTab === 'all' ? (
              <ChatHistoryView accountId={accountId} onboarding={onboarding} routeState={routeState} />
            ) : (
              <NeedsAttentionView accountId={accountId} routeState={routeState} />
            )
          ) : currentView === 'quality' ? (
            routeState.qualityView === 'audience-pulse' ? (
              <AudiencePulseView accountId={accountId} routeState={routeState} />
            ) : (
              <QualityView accountId={accountId} routeState={routeState} />
            )
          ) : currentView === 'eval' ? (
            <EvalView accountId={accountId} routeState={routeState} />
          ) : currentView === 'copilot' && !copilotPermissionDenied ? (
            <CopilotView
              key={activeWorkspaceId ?? 'copilot'}
              accountId={accountId}
              routeState={routeState}
              availability={copilotAvailability}
            />
          ) : null}
          </div>
        </SidebarInset>
        {!copilotPermissionDenied ? <CopilotPanel accountId={accountId} routeState={routeState} availability={copilotAvailability} /> : null}
        {!copilotPermissionDenied ? <CopilotSelectionAffordance /> : null}
      </SidebarProvider>
    </CopilotContextProvider>
  )
}
