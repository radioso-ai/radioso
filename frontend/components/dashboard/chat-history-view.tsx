'use client'

import { type ReactNode } from 'react'

import {
  type ChatConversationTurn,
  type ContactHistoryDetail,
  type DocumentSearchResponse,
} from '@/lib/api'
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { CopyValueField } from '@/components/ui/copy-value-field'
import { LogoSpinner } from '@/components/ui/spinner'
import { ActivityTraceDetail } from './activity-trace-detail'
import { ActivityTraceGraph } from './activity-trace-graph'
import { ChatMessageThread } from './chat-message-thread'
import { type WorkspaceOnboardingState } from '@/lib/onboarding'
import { Bug, Check, Copy, Search, X } from 'lucide-react'
import {
  HistoryList,
} from '@/components/dashboard/history/history-list'
import { HistoryDocumentDialog } from '@/components/dashboard/history/history-document-dialog'
import { MetadataBadges } from '@/components/dashboard/shared/metadata-badges'
import { type DashboardRouteState } from '@/lib/dashboard-routes'
import { formatConversationSource } from '@/lib/history-source'
import {
  type DiagnosticPresentation,
  presentActivityOutcome,
  presentRunParameters,
} from '@/lib/activity-diagnostics'
import {
  HISTORY_PAGE_SIZE,
  useHistoryDetailState,
  useHistoryDocumentDialogState,
  useHistoryListState,
} from '@/components/dashboard/history/use-chat-history-state'

const toneStyles: Record<DiagnosticPresentation['tone'], string> = {
  neutral: 'border-border/70 bg-background/60',
  ok: 'border-emerald-500/30 bg-emerald-500/10',
  warning: 'border-amber-500/30 bg-amber-500/10',
  error: 'border-destructive/30 bg-destructive/10',
}

function CompactIdField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    await navigator.clipboard.writeText(value)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  return (
    <button
      type="button"
      onClick={() => void handleCopy()}
      className="flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs transition hover:bg-muted/50"
      title={`Copy ${label} ID: ${value}`}
    >
      <span className="shrink-0 font-medium text-muted-foreground">{label}</span>
      <code className="min-w-0 truncate font-mono text-foreground">{value}</code>
      {copied ? <Check className="h-3 w-3 shrink-0 text-green-500" /> : <Copy className="h-3 w-3 shrink-0 text-muted-foreground" />}
    </button>
  )
}

const contactStatusLabels: Record<ContactHistoryDetail['status'], string> = {
  pending: 'Pending',
  delivering: 'Delivering',
  delivered: 'Delivered',
  failed: 'Failed',
}

function ContactRequestPanel({
  contact,
  className,
}: {
  contact: ContactHistoryDetail
  className?: string
}) {
  return (
    <div className={className}>
      <div className="rounded-lg border border-border/70 bg-background/70 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-foreground">Contact request</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {contactStatusLabels[contact.status]} - {contact.triggerSource.replaceAll('_', ' ')}
            </p>
          </div>
          <CopyValueField
            label="Email:"
            value={contact.userEmail}
            copyValue={contact.userEmail}
            ariaLabel="Copy contact email"
            compact
            fitContent
            inlineLabel
          />
        </div>
        <div className="mt-4">
          <p className="text-xs font-medium uppercase tracking-normal text-muted-foreground">Message</p>
          <p className="mt-1 whitespace-pre-wrap text-sm text-foreground">{contact.message}</p>
        </div>
        {contact.triggerReason || contact.finalDeliveryError ? (
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            {contact.triggerReason ? (
              <div>
                <p className="text-xs font-medium uppercase tracking-normal text-muted-foreground">Trigger reason</p>
                <p className="mt-1 text-sm text-muted-foreground">{contact.triggerReason}</p>
              </div>
            ) : null}
            {contact.finalDeliveryError ? (
              <div>
                <p className="text-xs font-medium uppercase tracking-normal text-muted-foreground">Delivery error</p>
                <p className="mt-1 text-sm text-destructive">{contact.finalDeliveryError}</p>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}

export function ChatHistoryView({
  accountId,
  onboarding,
  routeState,
}: {
  accountId: string
  onboarding: WorkspaceOnboardingState
  routeState: DashboardRouteState
}) {
  const {
    filter,
    isListLoading,
    hasAnyHistory,
    listError,
    conversations: conversationPageItems,
    conversationTotal,
    conversationPage,
    conversationTotalPages,
    searches: searchPageItems,
    searchTotal,
    searchPage,
    searchTotalPages,
    contacts: contactPageItems,
    contactTotal,
    contactPage,
    contactTotalPages,
    allHistoryItems,
    allTotal,
    allPage,
    allTotalPages,
    selectedItem,
    setSelectedItem,
    pushHistoryRoute,
    onFilterChange,
    onSelectItem,
    onConversationPageChange,
    onSearchPageChange,
    onContactPageChange,
    onAllPageChange,
    onNavigate,
  } = useHistoryListState({ accountId, routeState })

  const {
    conversationDetail,
    searchDetail,
    contactDetail,
    isDetailLoading,
    detailError,
    selectedThreadMessage,
    selectedThreadMessageId,
    selectedDiagnosticsAssistantMessage,
    activeTrace,
    activeInitialStageId,
    selectedStageId,
    setSelectedStageId,
    showGraph,
    setShowGraph,
    handleSelectThreadMessage,
    loadOlderMessages,
  } = useHistoryDetailState({ selectedItem, setSelectedItem, pushHistoryRoute })

  const {
    isDocumentDialogOpen,
    isDocumentLoading,
    documentDetail,
    documentError,
    handleOpenCitation,
    handleDocumentDialogOpenChange,
  } = useHistoryDocumentDialogState()

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <HistoryList
        accountId={accountId}
        workspaceId={routeState.workspaceId}
        routeState={routeState}
        onboarding={onboarding}
        filter={filter}
        isLoading={isListLoading}
        hasAnyHistory={hasAnyHistory}
        listError={listError}
        pageSize={HISTORY_PAGE_SIZE}
        conversations={conversationPageItems}
        conversationTotal={conversationTotal}
        conversationPage={conversationPage}
        conversationTotalPages={conversationTotalPages}
        searches={searchPageItems}
        searchTotal={searchTotal}
        searchPage={searchPage}
        searchTotalPages={searchTotalPages}
        contacts={contactPageItems}
        contactTotal={contactTotal}
        contactPage={contactPage}
        contactTotalPages={contactTotalPages}
        allHistoryItems={allHistoryItems}
        allTotal={allTotal}
        allPage={allPage}
        allTotalPages={allTotalPages}
        onFilterChange={onFilterChange}
        onSelectItem={onSelectItem}
        onConversationPageChange={onConversationPageChange}
        onSearchPageChange={onSearchPageChange}
        onContactPageChange={onContactPageChange}
        onAllPageChange={onAllPageChange}
        onNavigate={onNavigate}
      />

      <Drawer
        open={selectedItem !== null}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedItem(null)
            setShowGraph(false)
            pushHistoryRoute({ selectedItem: null })
          }
        }}
        direction="right"
        handleOnly
      >
        <DrawerContent
          className={`h-full !w-[96vw] !max-w-[96vw] transition-[width,max-width] duration-300 ease-in-out ${
            showGraph
              ? 'lg:!w-[94vw] lg:!max-w-[94vw]'
              : 'lg:!w-[56vw] lg:!max-w-[56vw]'
          }`}
        >
          <DrawerHeader className="border-b border-border py-3">
            <div className="flex items-center justify-between gap-4">
              <DrawerTitle className="sr-only">
                {selectedItem?.kind === 'chat'
                  ? 'Conversation details'
                  : selectedItem?.kind === 'contact'
                    ? 'Contact request details'
                    : 'Search details'}
              </DrawerTitle>
              <div className="flex min-w-0 items-center gap-3">
                {selectedItem ? (
                  <CompactIdField
                    label={selectedItem.kind === 'chat' ? 'Conversation' : selectedItem.kind === 'contact' ? 'Contact' : 'Search'}
                    value={selectedItem.id}
                  />
                ) : null}
                {(selectedItem?.kind === 'chat' || selectedItem?.kind === 'contact') && conversationDetail ? (() => {
                  const source = formatConversationSource(conversationDetail.sourceChannel, conversationDetail.sourceOrigin)
                  return source ? (
                    <span className="shrink-0 rounded-full bg-muted px-2.5 py-0.5 text-xs text-muted-foreground">{source}</span>
                  ) : null
                })() : null}
              </div>
              <div className="flex items-center gap-2">
                {activeTrace ? (
                  <Button
                    type="button"
                    size="sm"
                    variant={showGraph ? 'secondary' : 'outline'}
                    className="gap-1.5"
                    onClick={() => {
                      if (showGraph) {
                        setShowGraph(false)
                        setSelectedStageId(activeInitialStageId)
                      } else {
                        setShowGraph(true)
                      }
                    }}
                  >
                    <Bug className="h-3.5 w-3.5" />
                    {showGraph ? 'Close' : 'Debug'}
                  </Button>
                ) : null}
                <DrawerClose className="shrink-0 rounded-md p-1 text-muted-foreground hover:text-foreground">
                  <X className="h-4 w-4" />
                </DrawerClose>
              </div>
            </div>
            <DrawerDescription className="sr-only">Activity details panel</DrawerDescription>
          </DrawerHeader>

          <div className="min-h-0 flex-1 overflow-hidden p-4">
            {isDetailLoading ? (
              <div className="flex h-full items-center justify-center">
                <LogoSpinner imageClassName="h-7 w-7" />
              </div>
            ) : detailError ? (
              <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
                {detailError}
              </div>
            ) : (selectedItem?.kind === 'chat' || selectedItem?.kind === 'contact') && conversationDetail ? (
              <div className={`grid h-full min-h-0 gap-4 ${showGraph ? 'xl:grid-cols-[minmax(280px,0.8fr)_minmax(0,1.2fr)]' : ''}`}>
                <div className="min-h-0 overflow-y-auto pr-1">
                  {selectedItem.kind === 'contact' && contactDetail ? (
                    <ContactRequestPanel contact={contactDetail.contact} className="mb-4" />
                  ) : null}
                  {conversationDetail.hasOlderMessages ? (
                    <div className="mb-3 flex justify-center">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={isDetailLoading || !conversationDetail.nextCursor}
                        onClick={() => void loadOlderMessages()}
                      >
                        Load older messages
                      </Button>
                    </div>
                  ) : null}
                  <ChatMessageThread
                    messages={conversationDetail.messages.map((message) =>
                      // History messages already have a persisted DB id; the
                      // ChatMessageThread component derives `assistantMessageId`
                      // from `persistedAssistantMessageId`, which is only set
                      // by the live-streaming flow. Mirror it from `id` here
                      // so feedback + send-to-eval render on historical turns.
                      message.role === 'assistant'
                        ? { ...message, persistedAssistantMessageId: message.id }
                        : message
                    )}
                    onOpenDocument={handleOpenCitation}
                    onMessageSelect={handleSelectThreadMessage}
                    selectedMessageId={selectedThreadMessageId ?? undefined}
                    conversationId={selectedItem?.kind === 'chat' ? selectedItem.id : undefined}
                  />
                </div>

                {showGraph ? (
                  <div className="min-h-0 overflow-y-auto rounded-xl border border-border/70 bg-background/50 p-4">
                    <ChatDiagnosticsPanel
                      selectedMessage={selectedThreadMessage}
                      diagnosticsMessage={selectedDiagnosticsAssistantMessage}
                      activityTrace={activeTrace}
                      selectedStageId={selectedStageId}
                      graphPane={
                        activeTrace ? (
                          <ActivityTraceGraph
                            activityTrace={activeTrace}
                            selectedStageId={selectedStageId ?? activeTrace?.stages[0]?.stageId ?? ''}
                            onSelectStage={setSelectedStageId}
                          />
                        ) : (
                          <div className="rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">
                            Activity trace unavailable for this turn.
                          </div>
                        )
                      }
                    />
                  </div>
                ) : null}
              </div>
            ) : selectedItem?.kind === 'search' && searchDetail ? (
              <div className={`grid h-full min-h-0 gap-4 ${showGraph ? 'xl:grid-cols-[minmax(280px,0.8fr)_minmax(0,1.2fr)]' : ''}`}>
                <div className="min-h-0 overflow-y-auto pr-1">
                  <div className="space-y-4">
                    <div>
                      <p className="text-lg font-medium text-foreground">{searchDetail.query}</p>
                      <p className="text-sm text-muted-foreground">
                        {searchDetail.resultCount} document{searchDetail.resultCount === 1 ? '' : 's'} retrieved
                      </p>
                    </div>

                    {searchDetail.results.length === 0 ? (
                      <div className="rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground">
                        No matching documents were stored for this search.
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {searchDetail.results.map((result) => (
                          <button
                            key={`${searchDetail.searchId}-${result.documentId}`}
                            type="button"
                            onClick={() => void handleOpenCitation(result.documentId)}
                            disabled={!result.actions.some((action) => action.type === 'open_document' && action.status === 'available')}
                            className="w-full rounded-lg border border-border bg-card p-4 text-left transition hover:border-primary/40 hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            <div className="space-y-2">
                              <div className="flex items-center gap-2">
                                <Search className="h-4 w-4 text-muted-foreground" />
                                <p className="text-sm font-medium text-foreground">{result.title}</p>
                              </div>
                              <p className="text-xs text-muted-foreground">
                                Rank {result.rank} • Score {result.score.toFixed(3)}
                              </p>
                              <MetadataBadges metadata={result.metadata} className="" />
                              {result.matchEvidence.map((evidence) => (
                                <p key={evidence} className="text-sm text-muted-foreground">
                                  {evidence}
                                </p>
                              ))}
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {showGraph && searchDetail.activityTrace ? (
                  <div className="min-h-0 overflow-y-auto rounded-xl border border-border/70 bg-background/50 p-4">
                    <SearchDiagnosticsPanel
                      search={searchDetail}
                      selectedStageId={selectedStageId}
                      graphPane={
                        <ActivityTraceGraph
                          activityTrace={searchDetail.activityTrace}
                          selectedStageId={selectedStageId ?? searchDetail.activityTrace.stages[0]?.stageId ?? ''}
                          onSelectStage={setSelectedStageId}
                        />
                      }
                    />
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                Select an activity entry to inspect it.
              </div>
            )}
          </div>
        </DrawerContent>
      </Drawer>

      <HistoryDocumentDialog
        open={isDocumentDialogOpen}
        isLoading={isDocumentLoading}
        error={documentError}
        document={documentDetail}
        onOpenChange={handleDocumentDialogOpenChange}
      />
    </div>
  )
}

function DiagnosticPresentationSection({
  label,
  presentation,
}: {
  label: string
  presentation: DiagnosticPresentation
}) {
  return (
    <section className={`rounded-lg border p-3 ${toneStyles[presentation.tone]}`}>
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-base font-medium text-foreground">{presentation.title}</p>
      <p className="mt-1 text-sm leading-6 text-muted-foreground">{presentation.summary}</p>
      {presentation.facts.length ? (
        <dl className="mt-3 grid gap-x-4 gap-y-2 sm:grid-cols-2">
          {presentation.facts.map((fact) => (
            <div key={`${label}-${fact.label}`} className="min-w-0">
              <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{fact.label}</dt>
              <dd className="mt-0.5 break-words text-sm text-foreground">{fact.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </section>
  )
}

function ChatDiagnosticsPanel({
  selectedMessage,
  diagnosticsMessage,
  activityTrace,
  selectedStageId,
  graphPane,
}: {
  selectedMessage: ChatConversationTurn | null
  diagnosticsMessage: ChatConversationTurn | null
  activityTrace?: NonNullable<ChatConversationTurn['debug']>['activityTrace']
  selectedStageId?: string
  graphPane: ReactNode
}) {
  if (!selectedMessage) {
    return (
      <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
        Select a message to inspect diagnostics.
      </div>
    )
  }

  const diagnosticsDebug =
    diagnosticsMessage?.role === 'assistant' ? diagnosticsMessage.debug : undefined
  const resolvedActivityTrace = activityTrace ?? diagnosticsDebug?.activityTrace
  const outcomePresentation = presentActivityOutcome({
    trace: resolvedActivityTrace,
    route: diagnosticsDebug?.route,
  })
  const runParameters = presentRunParameters(resolvedActivityTrace)

  return (
    <div className="space-y-4">
      <CompactIdField label="Message" value={selectedMessage.id} />

      {diagnosticsDebug?.errorMessage ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {diagnosticsDebug.errorMessage}
        </div>
      ) : null}

      <DiagnosticPresentationSection label="Outcome summary" presentation={outcomePresentation} />

      {runParameters ? (
        <DiagnosticPresentationSection label="Run parameters" presentation={runParameters} />
      ) : null}

      <div className="grid grid-cols-[minmax(180px,220px)_1fr] gap-4">
        <div className="sticky top-0 self-start overflow-y-auto rounded-lg border border-border/50 bg-muted/20 p-2">
          {graphPane}
        </div>
        <div className="min-h-0">
          <ActivityTraceDetail
            activityTrace={resolvedActivityTrace}
            selectedStageId={selectedStageId}
          />
        </div>
      </div>
    </div>
  )
}

function SearchDiagnosticsPanel({
  search,
  selectedStageId,
  graphPane,
}: {
  search: DocumentSearchResponse
  selectedStageId?: string
  graphPane: ReactNode
}) {
  if (!search.activityTrace) {
    return (
      <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
        Diagnostics are unavailable for this search.
      </div>
    )
  }

  const outcomePresentation = presentActivityOutcome({ trace: search.activityTrace })
  const runParameters = presentRunParameters(search.activityTrace)

  return (
    <div className="space-y-4">
      <DiagnosticPresentationSection label="Outcome summary" presentation={outcomePresentation} />
      {runParameters ? (
        <DiagnosticPresentationSection label="Run parameters" presentation={runParameters} />
      ) : null}
      <div className="grid grid-cols-[minmax(180px,220px)_1fr] gap-4">
        <div className="sticky top-0 self-start overflow-y-auto rounded-lg border border-border/50 bg-muted/20 p-2">
          {graphPane}
        </div>
        <div className="min-h-0">
          <ActivityTraceDetail
            activityTrace={search.activityTrace}
            selectedStageId={selectedStageId}
          />
        </div>
      </div>
    </div>
  )
}
