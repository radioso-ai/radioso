'use client'

import { useRouter } from 'next/navigation'

import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar'
import { AppSidebar } from './app-sidebar'
import { ChatView } from './chat-view'
import { ChatHistoryView } from './chat-history-view'
import { DocumentsView } from './documents-view'
import { SettingsView } from './settings-view'
import { FirstRunExperience } from './first-run-experience'
import { buildAccountRoute, type DashboardSection } from '@/lib/dashboard-routes'
import { useWorkspace } from '@/lib/workspace-context'
import { useWorkspaceOnboarding } from '@/lib/onboarding'

interface DashboardShellProps {
  accountId: string
  currentView: DashboardSection
  selectedDocumentId?: string
}

export function DashboardShell({
  accountId,
  currentView,
  selectedDocumentId,
}: DashboardShellProps) {
  const router = useRouter()
  const { activeWorkspaceId } = useWorkspace()
  const onboarding = useWorkspaceOnboarding(activeWorkspaceId)

  const openDocument = (documentId: string | null) => {
    router.push(buildAccountRoute(accountId, 'documents', documentId ?? undefined))
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
            <ChatHistoryView accountId={accountId} onboarding={onboarding} />
          )}
          {currentView === 'documents' && (
            <DocumentsView
              selectedDocumentId={selectedDocumentId ?? null}
              onSelectedDocumentChange={openDocument}
              onboarding={onboarding}
            />
          )}
          {currentView === 'settings' && <SettingsView />}
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}
