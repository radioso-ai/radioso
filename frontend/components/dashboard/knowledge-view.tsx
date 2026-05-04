'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

import { DocumentsView } from '@/components/dashboard/documents-view'
import { DashboardPage } from '@/components/dashboard/shared/dashboard-page'
import { IngestionSettingsPanel } from '@/components/dashboard/settings/ingestion-settings-panel'
import { RetrievalSettingsPanel } from '@/components/dashboard/settings/retrieval-settings-panel'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  buildDashboardHref,
  type DashboardRouteState,
  type KnowledgeTab,
} from '@/lib/dashboard-routes'
import { type WorkspaceOnboardingState } from '@/lib/onboarding'

const knowledgeTabSummaries: Record<KnowledgeTab, string> = {
  documents: 'Manage the shared knowledge available in this workspace.',
  ingestion: 'Control how documents are split before they become searchable.',
  retrieval: 'Control how this workspace finds evidence for grounded answers.',
}

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
  const [ingestionSaveState, setIngestionSaveState] = useState<{
    state: 'idle' | 'saved' | 'saving' | 'error'
    message?: string | null
  }>({ state: 'idle' })
  const [retrievalSaveState, setRetrievalSaveState] = useState<{
    state: 'idle' | 'saved' | 'saving' | 'error'
    message?: string | null
  }>({ state: 'idle' })
  const activeSaveState =
    activeTab === 'retrieval'
      ? retrievalSaveState
      : activeTab === 'ingestion'
        ? ingestionSaveState
        : { state: 'idle' as const }

  const tabNavigation = (
    <TabsList>
      <TabsTrigger value="documents">Documents</TabsTrigger>
      <TabsTrigger value="ingestion">Ingestion</TabsTrigger>
      <TabsTrigger value="retrieval">Retrieval</TabsTrigger>
    </TabsList>
  )

  const saveStateAccessory = (
    <div className="text-sm">
      {activeSaveState.state === 'saving' ? (
        <span className="text-muted-foreground">Saving...</span>
      ) : activeSaveState.state === 'error' ? (
        <span className="text-destructive">
          {activeSaveState.message ?? 'Failed to save changes'}
        </span>
      ) : activeSaveState.state === 'saved' ? (
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
        section: 'knowledge',
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
        router.push(buildDashboardHref(accountId, {
          ...routeState,
          section: 'knowledge',
          knowledgeTab: value as KnowledgeTab,
          documentId: undefined,
          documentsPage: undefined,
          anchor: undefined,
        }))
      }}
      className="h-full min-h-0 gap-0"
    >
      <TabsContent value="documents" className="min-h-0 flex flex-1 flex-col overflow-hidden">
        <DocumentsView
          routeState={routeState}
          accountId={accountId}
          selectedDocumentId={selectedDocumentId}
          onSelectedDocumentChange={onSelectedDocumentChange}
          onboarding={onboarding}
          navigation={tabNavigation}
        />
      </TabsContent>

      <TabsContent value="ingestion" className="min-h-0 flex flex-1 flex-col overflow-hidden">
        <DashboardPage
          title="Knowledge Base"
          description={knowledgeTabSummaries.ingestion}
          titleAccessory={saveStateAccessory}
          actions={tabNavigation}
          contentClassName="flex flex-col overflow-hidden p-0"
          contentScroll={false}
        >
          <IngestionSettingsPanel onSaveStateChange={setIngestionSaveState} />
        </DashboardPage>
      </TabsContent>

      <TabsContent value="retrieval" className="min-h-0 flex flex-1 flex-col overflow-hidden">
        <DashboardPage
          title="Knowledge Base"
          description={knowledgeTabSummaries.retrieval}
          titleAccessory={saveStateAccessory}
          actions={tabNavigation}
          contentClassName="flex flex-col overflow-hidden p-0"
          contentScroll={false}
        >
          <RetrievalSettingsPanel onSaveStateChange={setRetrievalSaveState} />
        </DashboardPage>
      </TabsContent>
    </Tabs>
  )
}
