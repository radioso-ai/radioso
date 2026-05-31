'use client'

import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'

import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar'
import { AppSidebar } from './app-sidebar'
import { AgentSubNavContainer } from './agent-subnav-container'
import { AccountSubNav, KnowledgeSubNav, SettingsSubNav } from './area-subnavs'
import { AgentView } from './agent-view'
import { AccountView } from './account-view'
import { ChatHistoryView } from './chat-history-view'
import { KnowledgeView } from './knowledge-view'
import { SettingsView } from './settings-view'
import { QualityView } from './quality-view'
import { EvalView } from './eval-view'
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
import { useIsMobile } from '@/hooks/use-mobile'
import { LogoSpinner } from '@/components/ui/spinner'

interface DashboardShellProps {
  accountId: string
  routeState: DashboardRouteState
}

export function DashboardShell({
  accountId,
  routeState,
}: DashboardShellProps) {
  const router = useRouter()
  const isMobile = useIsMobile()
  const routeWorkspaceSyncKeyRef = useRef<string | null>(null)
  const pendingRouteWorkspaceIdRef = useRef<string | null>(null)
  const { activeWorkspaceId, workspaces, isLoading: isWorkspaceLoading, switchWorkspace } = useWorkspace()
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
  // The icon rail is always collapsed for a stable first column; only the
  // second column appears or disappears per area. The first-run takeover shows
  // full-width with no second column.
  const showFirstRun = isAgentChatView && onboarding.shouldShowFirstRun
  const area = activeArea(routeState)
  const hasSubNav = area !== null && !showFirstRun

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

  const openDocument = (documentId: string | null) => {
    router.push(buildDashboardHref(accountId, {
      ...routeState,
      section: 'knowledge',
      knowledgeTab: 'documents',
      documentId: documentId ?? undefined,
      workspaceId: activeWorkspaceId ?? undefined,
      workspacePublicRouteKey: activeWorkspacePublicRouteKey,
    }))
  }

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
      <SidebarProvider open={false} onOpenChange={() => {}} className="h-svh min-h-0 overflow-hidden">
        <AppSidebar accountId={accountId} currentView={currentView} routeState={routeState} />
        <SidebarInset className="min-h-0 overflow-hidden">
          <header className="sticky top-0 z-40 flex h-12 shrink-0 items-center border-b border-border bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/80 md:hidden">
            <SidebarTrigger />
          </header>
          <div className="flex h-[calc(100vh-3rem)] min-h-0 flex-1 items-center justify-center md:h-screen">
            <LogoSpinner imageClassName="h-7 w-7" />
          </div>
        </SidebarInset>
      </SidebarProvider>
    )
  }

  // The sub-nav renders in exactly one place per breakpoint: inline beside the
  // content on desktop, or inside the rail drawer on mobile. Computing it once
  // keeps stateful containers (e.g. the agent switcher) from mounting twice.
  const subNav = !hasSubNav ? null : area === 'agents' ? (
    <AgentSubNavContainer accountId={accountId} routeState={routeState} />
  ) : area === 'knowledge' ? (
    <KnowledgeSubNav accountId={accountId} routeState={routeState} />
  ) : area === 'settings' ? (
    <SettingsSubNav accountId={accountId} routeState={routeState} />
  ) : (
    <AccountSubNav accountId={accountId} routeState={routeState} />
  )

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
    <AccountView routeState={routeState} />
  )

  return (
    <SidebarProvider open={false} onOpenChange={() => {}} className="h-svh min-h-0 overflow-hidden">
      <AppSidebar
        accountId={accountId}
        currentView={currentView}
        routeState={routeState}
        areaSubNav={isMobile ? subNav : undefined}
      />
      <SidebarInset className="min-h-0 overflow-hidden">
        <header className="sticky top-0 z-40 flex h-12 shrink-0 items-center border-b border-border bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/80 md:hidden">
          <SidebarTrigger />
        </header>
        <div key={activeWorkspaceId} className="flex h-[calc(100vh-3rem)] min-h-0 flex-1 flex-col md:h-screen">
          {showFirstRun ? (
            <FirstRunExperience accountId={accountId} onboarding={onboarding} />
          ) : hasSubNav ? (
            <div className="flex min-h-0 flex-1">
              {isMobile ? null : subNav}
              <div className="flex min-w-0 flex-1 flex-col">{areaContent}</div>
            </div>
          ) : currentView === 'activity' ? (
            <ChatHistoryView accountId={accountId} onboarding={onboarding} routeState={routeState} />
          ) : currentView === 'quality' ? (
            <QualityView accountId={accountId} routeState={routeState} />
          ) : currentView === 'eval' ? (
            <EvalView accountId={accountId} routeState={routeState} />
          ) : null}
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}
