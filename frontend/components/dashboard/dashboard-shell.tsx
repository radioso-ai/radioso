'use client'

import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'

import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar'
import { AppSidebar } from './app-sidebar'
import { ChatView } from './chat-view'
import { ChatHistoryView } from './chat-history-view'
import { DocumentsView } from './documents-view'
import { SettingsView } from './settings-view'
import { UsersView } from './users-view'
import { FirstRunExperience } from './first-run-experience'
import { buildDashboardHref, type DashboardRouteState } from '@/lib/dashboard-routes'
import { useWorkspace } from '@/lib/workspace-context'
import { useWorkspaceOnboarding } from '@/lib/onboarding'
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

    if (routeState.workspaceId === activeWorkspaceId) {
      return
    }

    router.replace(buildDashboardHref(accountId, {
      ...routeState,
      workspaceId: activeWorkspaceId,
      workspacePublicRouteKey: activeWorkspacePublicRouteKey,
    }))
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
      section: 'documents',
      documentId: documentId ?? undefined,
      workspacePublicRouteKey: activeWorkspacePublicRouteKey,
    }))
  }

  if (
    isWorkspaceLoading ||
    (currentView === 'chat' && onboarding.isLoading) ||
    (requestedWorkspaceId && requestedWorkspaceExists && activeWorkspaceId !== requestedWorkspaceId)
  ) {
    return (
      <SidebarProvider className="h-svh min-h-0 overflow-hidden">
        <AppSidebar accountId={accountId} currentView={currentView} />
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

  return (
    <SidebarProvider className="h-svh min-h-0 overflow-hidden">
      <AppSidebar accountId={accountId} currentView={currentView} />
      <SidebarInset className="min-h-0 overflow-hidden">
        <header className="sticky top-0 z-40 flex h-12 shrink-0 items-center border-b border-border bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/80 md:hidden">
          <SidebarTrigger />
        </header>
        <div key={activeWorkspaceId} className="flex h-[calc(100vh-3rem)] min-h-0 flex-1 flex-col md:h-screen">
          {currentView === 'chat' && (
            onboarding.shouldShowFirstRun ? (
              <FirstRunExperience accountId={accountId} onboarding={onboarding} />
            ) : (
              <ChatView
                accountId={accountId}
                onOpenDocument={openDocument}
                onboarding={onboarding}
              />
            )
          )}
          {currentView === 'history' && (
            <ChatHistoryView
              accountId={accountId}
              onboarding={onboarding}
              routeState={routeState}
            />
          )}
          {currentView === 'documents' && (
            <DocumentsView
              routeState={routeState}
              accountId={accountId}
              selectedDocumentId={routeState.documentId ?? null}
              onSelectedDocumentChange={openDocument}
              onboarding={onboarding}
            />
          )}
          {currentView === 'settings' && (
            <SettingsView accountId={accountId} routeState={routeState} />
          )}
          {currentView === 'users' && (
            <UsersView />
          )}
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}
