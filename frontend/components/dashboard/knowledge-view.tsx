'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

import { AddDocumentMenu, type AddDocumentAction } from '@/components/dashboard/documents/add-document-menu'
import { DocumentsView } from '@/components/dashboard/documents-view'
import { DocumentSourcesView } from '@/components/dashboard/document-sources-view'
import { DashboardPage } from '@/components/dashboard/shared/dashboard-page'
import { SaveStateIndicator } from '@/components/dashboard/shared/save-state-indicator'
import { IngestionSettingsPanel } from '@/components/dashboard/settings/ingestion-settings-panel'
import { buildDashboardHref, type DashboardRouteState } from '@/lib/dashboard-routes'
import { type WorkspaceOnboardingState } from '@/lib/onboarding'

export function KnowledgeView({
  accountId,
  routeState,
  selectedDocumentId,
  onSelectedDocumentChange,
  onboarding,
}: {
  accountId: string
  routeState: DashboardRouteState
  selectedDocumentId: string | null
  onSelectedDocumentChange: (documentId: string | null) => void
  onboarding: WorkspaceOnboardingState
}) {
  const router = useRouter()
  const activeTab = routeState.knowledgeTab ?? 'documents'
  const websiteCrawlerEnabled = onboarding.websiteCrawlerEnabled
  // The Sources tab's "Add" menu reuses the Documents tab's add dialogs: it
  // records the chosen action and routes to Documents, which opens the matching
  // dialog and clears the flag. Keeps a single set of add flows instead of
  // duplicating them.
  const [pendingAddAction, setPendingAddAction] = useState<AddDocumentAction | null>(null)
  const [ingestionSaveState, setIngestionSaveState] = useState<{
    state: 'idle' | 'saved' | 'saving' | 'error'
    message?: string | null
  }>({ state: 'idle' })

  const handleAddSelect = useCallback((action: AddDocumentAction) => {
    setPendingAddAction(action)
    router.push(
      buildDashboardHref(accountId, {
        ...routeState,
        section: 'knowledge',
        knowledgeTab: 'documents',
      }),
    )
  }, [accountId, routeState, router])

  const activeSaveState =
    activeTab === 'ingestion'
        ? ingestionSaveState
        : { state: 'idle' as const }

  const saveStateAccessory = <SaveStateIndicator saveState={activeSaveState} />

  useEffect(() => {
    if (!routeState.anchor) {
      return
    }

    const element = document.getElementById(routeState.anchor)
    if (!element) {
      router.replace(buildDashboardHref(accountId, {
        ...routeState,
        section: 'knowledge',
        anchor: undefined,
      }))
      return
    }

    element.scrollIntoView({ block: 'start', behavior: 'auto' })
  }, [accountId, routeState, router])

  if (activeTab === 'ingestion') {
    return (
      <DashboardPage
        title="Ingestion"
        titleAccessory={saveStateAccessory}
        contentClassName="flex flex-col overflow-hidden p-0"
        contentScroll={false}
      >
        <IngestionSettingsPanel onSaveStateChange={setIngestionSaveState} />
      </DashboardPage>
    )
  }

  if (activeTab === 'documents') {
    return (
      <DocumentsView
        routeState={routeState}
        accountId={accountId}
        selectedDocumentId={selectedDocumentId}
        onSelectedDocumentChange={onSelectedDocumentChange}
        onboarding={onboarding}
        autoOpenAdd={pendingAddAction}
        onAutoOpenAddHandled={() => setPendingAddAction(null)}
      />
    )
  }

  return (
    <DashboardPage
      title="Sources"
      description="Review the sources agents can use for scoped knowledge."
      actions={
        <AddDocumentMenu
          websiteCrawlerEnabled={websiteCrawlerEnabled}
          onSelect={handleAddSelect}
        />
      }
    >
      <DocumentSourcesView
        addSourceMenu={
          <AddDocumentMenu
            websiteCrawlerEnabled={websiteCrawlerEnabled}
            onSelect={handleAddSelect}
          />
        }
        onViewDocumentsForSource={(sourceId) => {
          router.push(
            buildDashboardHref(accountId, {
              ...routeState,
              section: 'knowledge',
              knowledgeTab: 'documents',
              documentSourceFilter: sourceId,
              documentsPage: undefined,
            }),
          )
        }}
      />
    </DashboardPage>
  )
}
