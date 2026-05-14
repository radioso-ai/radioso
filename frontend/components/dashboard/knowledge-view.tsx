'use client'

import { useEffect, useState } from 'react'
import { ArrowLeft, Settings2 } from 'lucide-react'
import { useRouter } from 'next/navigation'

import { DocumentsView } from '@/components/dashboard/documents-view'
import { DocumentSourcesView } from '@/components/dashboard/document-sources-view'
import { DashboardPage } from '@/components/dashboard/shared/dashboard-page'
import { IngestionSettingsPanel } from '@/components/dashboard/settings/ingestion-settings-panel'
import { RetrievalSettingsPanel } from '@/components/dashboard/settings/retrieval-settings-panel'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  buildDashboardHref,
  type DashboardRouteState,
  type KnowledgeTab,
} from '@/lib/dashboard-routes'
import { type WorkspaceOnboardingState } from '@/lib/onboarding'

const dataTabSummaries: Record<'documents' | 'sources', string> = {
  documents: 'Manage the shared knowledge available in this workspace.',
  sources: 'Review the sources agents can use for scoped knowledge.',
}

const configTabSummaries: Record<'ingestion' | 'retrieval', string> = {
  ingestion: 'Control how documents are split before they become searchable.',
  retrieval: 'Control how this workspace finds evidence for grounded answers.',
}

type ConfigTab = 'ingestion' | 'retrieval'

const isConfigTab = (tab: KnowledgeTab): tab is ConfigTab =>
  tab === 'ingestion' || tab === 'retrieval'

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

  const navigateToTab = (tab: KnowledgeTab) => {
    router.push(
      buildDashboardHref(accountId, {
        ...routeState,
        section: 'knowledge',
        knowledgeTab: tab,
        documentId: undefined,
        documentsPage: undefined,
        anchor: undefined,
      }),
    )
  }

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

  if (isConfigTab(activeTab)) {
    const configActions = (
      <>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => navigateToTab('documents')}
          className="gap-1.5"
        >
          <ArrowLeft className="size-4" />
          Back to knowledge
        </Button>
        <Tabs
          value={activeTab}
          onValueChange={(value) => navigateToTab(value as ConfigTab)}
        >
          <TabsList>
            <TabsTrigger value="ingestion">Ingestion</TabsTrigger>
            <TabsTrigger value="retrieval">Retrieval</TabsTrigger>
          </TabsList>
        </Tabs>
      </>
    )

    return (
      <DashboardPage
        title="Configure knowledge base"
        description={configTabSummaries[activeTab]}
        titleAccessory={saveStateAccessory}
        actions={configActions}
        contentClassName="flex flex-col overflow-hidden p-0"
        contentScroll={false}
      >
        {activeTab === 'ingestion' ? (
          <IngestionSettingsPanel onSaveStateChange={setIngestionSaveState} />
        ) : (
          <RetrievalSettingsPanel onSaveStateChange={setRetrievalSaveState} />
        )}
      </DashboardPage>
    )
  }

  const dataNavigation = (
    <>
      <Tabs
        value={activeTab}
        onValueChange={(value) => navigateToTab(value as 'documents' | 'sources')}
      >
        <TabsList>
          <TabsTrigger value="documents">Documents</TabsTrigger>
          <TabsTrigger value="sources">Sources</TabsTrigger>
        </TabsList>
      </Tabs>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Configure knowledge base"
            onClick={() => navigateToTab('ingestion')}
          >
            <Settings2 className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Configure knowledge base</TooltipContent>
      </Tooltip>
    </>
  )

  if (activeTab === 'documents') {
    return (
      <DocumentsView
        routeState={routeState}
        accountId={accountId}
        selectedDocumentId={selectedDocumentId}
        onSelectedDocumentChange={onSelectedDocumentChange}
        onboarding={onboarding}
        navigation={dataNavigation}
      />
    )
  }

  return (
    <DashboardPage
      title="Knowledge Base"
      description={dataTabSummaries.sources}
      actions={dataNavigation}
    >
      <DocumentSourcesView />
    </DashboardPage>
  )
}
