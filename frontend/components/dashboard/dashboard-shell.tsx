'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar'
import { AppSidebar } from './app-sidebar'
import { ChatView } from './chat-view'
import { ChatHistoryView } from './chat-history-view'
import { DocumentsView } from './documents-view'
import { SettingsView } from './settings-view'
import { FirstRunExperience } from './first-run-experience'
import { buildDashboardHref, type DashboardRouteState } from '@/lib/dashboard-routes'
import { useWorkspace } from '@/lib/workspace-context'
import { useWorkspaceOnboarding } from '@/lib/onboarding'
import { Spinner } from '@/components/ui/spinner'

interface DashboardShellProps {
  accountId: string
  routeState: DashboardRouteState
}

export function DashboardShell({
  accountId,
  routeState,
}: DashboardShellProps) {
  const router = useRouter()
  const { activeWorkspaceId, workspaces, isLoading: isWorkspaceLoading, switchWorkspace } = useWorkspace()
  const onboarding = useWorkspaceOnboarding(activeWorkspaceId, workspaces.length)
  const requestedWorkspaceId = routeState.workspaceId
  const requestedWorkspaceExists = requestedWorkspaceId
    ? workspaces.some((workspace) => workspace.id === requestedWorkspaceId)
    : false
  const currentView = routeState.section

  useEffect(() => {
    if (!requestedWorkspaceId || !requestedWorkspaceExists || activeWorkspaceId === requestedWorkspaceId) {
      return
    }

    void switchWorkspace(requestedWorkspaceId)
  }, [activeWorkspaceId, requestedWorkspaceExists, requestedWorkspaceId, switchWorkspace])

  useEffect(() => {
    if (!activeWorkspaceId) {
      return
    }

    if (requestedWorkspaceId && requestedWorkspaceExists && requestedWorkspaceId !== activeWorkspaceId) {
      return
    }

    if (routeState.workspaceId === activeWorkspaceId) {
      return
    }

    router.replace(buildDashboardHref(accountId, {
      ...routeState,
      workspaceId: activeWorkspaceId,
    }))
  }, [
    accountId,
    activeWorkspaceId,
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
    }))
  }

  if (
    isWorkspaceLoading ||
    (requestedWorkspaceId && requestedWorkspaceExists && activeWorkspaceId !== requestedWorkspaceId)
  ) {
    return (
      <SidebarProvider>
        <AppSidebar accountId={accountId} currentView={currentView} />
        <SidebarInset>
          <header className="flex h-12 items-center border-b border-border px-4 md:hidden">
            <SidebarTrigger />
          </header>
          <div className="flex h-[calc(100vh-3rem)] min-h-0 flex-1 items-center justify-center md:h-screen">
            <Spinner className="h-6 w-6" />
          </div>
        </SidebarInset>
      </SidebarProvider>
    )
  }

  return (
    <SidebarProvider>
      <AppSidebar accountId={accountId} currentView={currentView} />
      <SidebarInset>
        <header className="flex h-12 items-center border-b border-border px-4 md:hidden">
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
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}
