'use client'

import { type ReactNode } from 'react'

import {
  type ChatConversationTurn,
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
import { ActionButton } from '@/components/ui/action-button'
import { Button } from '@/components/ui/button'
import { CopyValueField } from '@/components/ui/copy-value-field'
import { LogoSpinner } from '@/components/ui/spinner'
import { ChatRetrievalInfo } from './chat-retrieval-info'
import { ChatRetrievalTraceGraph } from './chat-retrieval-trace-graph'
import { ChatMessageThread } from './chat-message-thread'
import { type WorkspaceOnboardingState } from '@/lib/onboarding'
import { Search, X } from 'lucide-react'
import {
  HistoryList,
} from '@/components/dashboard/history/history-list'
import { HistoryDocumentDialog } from '@/components/dashboard/history/history-document-dialog'
import { MetadataBadges } from '@/components/dashboard/shared/metadata-badges'
import { type DashboardRouteState } from '@/lib/dashboard-routes'
import { formatConversationSource } from '@/lib/history-source'
import {
  HISTORY_PAGE_SIZE,
  useHistoryDetailState,
  useHistoryDocumentDialogState,
  useHistoryListState,
} from '@/components/dashboard/history/use-chat-history-state'

const HIDDEN_SUPPORT_LABELS = {
  assistant_name: 'Assistant name',
} as const

const formatDiagnosticLabel = (value: string) => value.replaceAll('_', ' ')

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
    onAllPageChange,
    onNavigate,
  } = useHistoryListState({ accountId, routeState })

  const {
    conversationDetail,
    searchDetail,
    isDetailLoading,
    detailError,
    selectedThreadMessage,
    selectedThreadMessageId,
    selectedDiagnosticsAssistantMessage,
    selectedDiagnosticsTrace,
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
        allHistoryItems={allHistoryItems}
        allTotal={allTotal}
        allPage={allPage}
        allTotalPages={allTotalPages}
        onFilterChange={onFilterChange}
        onSelectItem={onSelectItem}
        onConversationPageChange={onConversationPageChange}
        onSearchPageChange={onSearchPageChange}
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
          className={`h-full transition-[width,max-width] duration-300 ease-in-out data-[vaul-drawer-direction=right]:w-[96vw] sm:data-[vaul-drawer-direction=right]:max-w-[96vw] ${
            showGraph
              ? 'lg:data-[vaul-drawer-direction=right]:w-[94vw] lg:data-[vaul-drawer-direction=right]:max-w-[94vw]'
              : 'lg:data-[vaul-drawer-direction=right]:w-[88vw] lg:data-[vaul-drawer-direction=right]:max-w-[88vw]'
          }`}
        >
          <DrawerHeader className="border-b border-border">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <DrawerTitle className="sr-only">
                  {selectedItem?.kind === 'chat' ? 'Conversation details' : 'Search details'}
                </DrawerTitle>
                {selectedItem ? (
                  <div className="space-y-1">
                    <CopyValueField
                      label={selectedItem.kind === 'chat' ? 'Conversation ID:' : 'Search ID:'}
                      value={selectedItem.id}
                      copyValue={selectedItem.id}
                      ariaLabel={selectedItem.kind === 'chat' ? 'Copy conversation ID' : 'Copy search ID'}
                      compact
                      wrap
                      fitContent
                      inlineLabel
                    />
                    {selectedItem.kind === 'chat' && conversationDetail ? (
                      <p className="text-xs text-muted-foreground">
                        {formatConversationSource(conversationDetail.sourceChannel, conversationDetail.sourceOrigin) ?? 'Direct chat'}
                      </p>
                    ) : null}
                  </div>
                ) : null}
                <DrawerDescription className="sr-only">Activity details panel</DrawerDescription>
              </div>
              <DrawerClose className="shrink-0 rounded-md p-1 text-muted-foreground hover:text-foreground">
                <X className="h-4 w-4" />
              </DrawerClose>
            </div>
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
            ) : selectedItem?.kind === 'chat' && conversationDetail ? (
              <div className="grid h-full min-h-0 gap-4 lg:grid-cols-[minmax(0,0.9fr)_minmax(640px,1.1fr)]">
                <div className="min-h-0 overflow-y-auto pr-1">
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
                    messages={conversationDetail.messages}
                    onOpenDocument={handleOpenCitation}
                    onMessageSelect={handleSelectThreadMessage}
                    selectedMessageId={selectedThreadMessageId ?? undefined}
                  />
                </div>

                <div className="min-h-0 overflow-y-auto rounded-xl border border-border/70 bg-background/50 p-4">
                  <ChatDiagnosticsPanel
                    selectedMessage={selectedThreadMessage}
                    diagnosticsMessage={selectedDiagnosticsAssistantMessage}
                    showGraph={showGraph}
                    onShowGraph={() => {
                      if (selectedDiagnosticsAssistantMessage?.debug?.retrievalTrace) {
                        setShowGraph(true)
                      }
                    }}
                    onHideGraph={() => {
                      setShowGraph(false)
                      setSelectedStageId(activeInitialStageId)
                    }}
                    selectedStageId={selectedStageId}
                    graphPane={
                      showGraph ? (
                        selectedDiagnosticsTrace ? (
                          <ChatRetrievalTraceGraph
                            retrievalTrace={selectedDiagnosticsTrace}
                            selectedStageId={selectedStageId ?? selectedDiagnosticsTrace.stages[0]?.stageId ?? ''}
                            onSelectStage={setSelectedStageId}
                          />
                        ) : (
                          <div className="rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">
                            Detailed retrieval trace unavailable for this assistant turn. Trigger-analysis details only appear when the backend captured replayable diagnostics.
                          </div>
                        )
                      ) : null
                    }
                  />
                </div>
              </div>
            ) : selectedItem?.kind === 'search' && searchDetail ? (
              <div className="grid h-full min-h-0 gap-4 lg:grid-cols-[minmax(0,0.9fr)_minmax(420px,1.1fr)]">
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

                <div className="min-h-0 overflow-y-auto rounded-xl border border-border/70 bg-background/50 p-4">
                  <SearchDiagnosticsPanel
                    search={searchDetail}
                    showGraph={showGraph}
                    onShowGraph={() => {
                      if (searchDetail.retrievalTrace) {
                        setShowGraph(true)
                      }
                    }}
                    onHideGraph={() => {
                      setShowGraph(false)
                      setSelectedStageId(activeInitialStageId)
                    }}
                    selectedStageId={selectedStageId}
                    graphPane={
                      showGraph ? (
                        <ChatRetrievalTraceGraph
                          retrievalTrace={searchDetail.retrievalTrace!}
                          selectedStageId={selectedStageId ?? searchDetail.retrievalTrace?.stages[0]?.stageId ?? ''}
                          onSelectStage={setSelectedStageId}
                        />
                      ) : null
                    }
                  />
                </div>
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

function ChatDiagnosticsPanel({
  selectedMessage,
  diagnosticsMessage,
  showGraph,
  onShowGraph,
  onHideGraph,
  selectedStageId,
  graphPane,
}: {
  selectedMessage: ChatConversationTurn | null
  diagnosticsMessage: ChatConversationTurn | null
  showGraph: boolean
  onShowGraph: () => void
  onHideGraph: () => void
  selectedStageId?: string
  graphPane: ReactNode
}) {
  const inputMethodLabel =
    selectedMessage?.inputMetadata?.method === 'suggestion_click'
      ? 'Suggested question'
      : selectedMessage?.inputMetadata?.method === 'typed'
        ? 'Typed'
        : null

  if (!selectedMessage) {
    return (
      <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
        Select a message to inspect diagnostics.
      </div>
    )
  }

  const diagnosticsDebug =
    diagnosticsMessage?.role === 'assistant' ? diagnosticsMessage.debug : undefined
  const hasDiagnostics = Boolean(diagnosticsDebug)

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-4">
        <div className="flex min-w-0 flex-1 items-start gap-4">
          <p className="pt-2 text-sm font-medium text-foreground whitespace-nowrap">Message ID:</p>
          <div className="min-w-0 flex-1">
            <CopyValueField
              value={selectedMessage.id}
              copyValue={selectedMessage.id}
              ariaLabel={`Copy ${selectedMessage.role} message ID`}
              compact
              wrap
            />
          </div>
        </div>
        {diagnosticsDebug?.retrievalTrace ? (
          <div className="shrink-0">
            <ActionButton
              type="button"
              size="sm"
              theme="yellow"
              className="h-9 px-4 text-sm"
              onClick={showGraph ? onHideGraph : onShowGraph}
            >
            {showGraph ? 'Hide graph' : 'Show graph'}
            </ActionButton>
          </div>
        ) : null}
      </div>

      {selectedMessage.role === 'user' && inputMethodLabel ? (
        <div className="rounded-lg border border-border/70 bg-background/70 p-4">
          <p className="text-sm font-medium text-foreground">Input method</p>
          <p className="mt-1 text-sm text-muted-foreground">{inputMethodLabel}</p>
        </div>
      ) : null}

      {!hasDiagnostics ? (
        <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
          No diagnostics are available for this message yet.
        </div>
      ) : null}

      {diagnosticsDebug?.errorMessage ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {diagnosticsDebug?.errorMessage}
        </div>
      ) : null}

      {diagnosticsDebug?.route ? (
        <div className="rounded-lg border border-border/70 bg-background/70 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium text-foreground">Response route</p>
            <span className="rounded-full border border-border bg-muted px-2.5 py-1 text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
              {formatDiagnosticLabel(diagnosticsDebug.route.generator)}
            </span>
            <span className="rounded-full border border-border bg-muted/60 px-2.5 py-1 text-xs font-medium text-muted-foreground">
              {formatDiagnosticLabel(diagnosticsDebug.route.routeType)}
            </span>
            <span className="rounded-full border border-border bg-muted/60 px-2.5 py-1 text-xs font-medium text-muted-foreground">
              {formatDiagnosticLabel(diagnosticsDebug.route.routeReason)}
            </span>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            Retrieval {diagnosticsDebug.route.retrievalInvoked ? 'was invoked for this assistant response.' : 'was skipped for this assistant response.'}
          </p>
        </div>
      ) : null}

      {diagnosticsDebug?.conversationMode ? (
        <div className="rounded-lg border border-border/70 bg-background/70 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium text-foreground">Conversation mode</p>
            <span className="rounded-full border border-border bg-muted px-2.5 py-1 text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
              {diagnosticsDebug.conversationMode}
            </span>
            {diagnosticsDebug.conversationModeMetadata?.expansionApplied ? (
              <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:text-emerald-300">
                {diagnosticsDebug.conversationModeMetadata.expansionKind === 'focused' ? 'Focused expansion' : 'Expansive expansion'}
              </span>
            ) : (
              <span className="rounded-full border border-border bg-muted/60 px-2.5 py-1 text-xs font-medium text-muted-foreground">
                Direct answer only
              </span>
            )}
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            {diagnosticsDebug.conversationModeMetadata?.brevityOverrideApplied
              ? 'This turn honored an explicit user request for brevity, so optional exploration was suppressed.'
              : diagnosticsDebug.conversationModeMetadata?.expansionApplied
                ? `The assistant added ${diagnosticsDebug.conversationModeMetadata.suggestionCount} grounded continuation${diagnosticsDebug.conversationModeMetadata.suggestionCount === 1 ? '' : 's'}${diagnosticsDebug.conversationModeMetadata.followUpQuestionApplied ? ' and a grounded follow-up prompt.' : '.'}`
                : 'No optional grounded continuation was added for this turn.'}
          </p>
        </div>
      ) : null}

      {diagnosticsDebug?.validation ? (
          <div className="rounded-lg border border-border/70 bg-background/70 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium text-foreground">Validation</p>
            <span className="rounded-full border border-border bg-muted/60 px-2.5 py-1 text-xs font-medium text-muted-foreground">
              {diagnosticsDebug.validation.answerModified ? 'Answer modified' : 'Answer unchanged'}
            </span>
            {diagnosticsDebug.validation.hiddenSupportUsed ? (
              <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-700 dark:text-amber-300">
                Hidden support used
              </span>
            ) : null}
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            Supported segments: {diagnosticsDebug.validation.supportedSegmentCount}. Unsupported segments:{' '}
            {diagnosticsDebug.validation.unsupportedSegmentCount}. Non-substantive segments:{' '}
            {diagnosticsDebug.validation.nonSubstantiveSegmentCount}.
          </p>
          {diagnosticsDebug.validation.hiddenSupportUsed ? (
            <>
              <p className="mt-2 text-sm text-muted-foreground">
                This turn used non-citable setup evidence during validation. Document citations remain unchanged.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {(diagnosticsDebug.validation.hiddenSupportKindsUsed ?? []).map((kind) => (
                  <span
                    key={kind}
                    className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-700 dark:text-amber-300"
                  >
                    {HIDDEN_SUPPORT_LABELS[kind]}
                  </span>
                ))}
              </div>
            </>
          ) : null}
        </div>
      ) : null}

      {hasDiagnostics ? (
        <div
          className="grid gap-4 overflow-hidden"
          style={{
            gridTemplateColumns: showGraph ? 'minmax(380px,1fr) minmax(0,1.1fr)' : '0px minmax(0,1fr)',
            transition: 'grid-template-columns 300ms ease',
          }}
        >
          <div
            className="overflow-hidden rounded-xl border border-border/70 bg-background/60 p-4"
            style={{
              opacity: showGraph ? 1 : 0,
              transform: showGraph ? 'translateX(0)' : 'translateX(12px)',
              transition: 'opacity 300ms ease, transform 300ms ease',
              pointerEvents: showGraph ? 'auto' : 'none',
            }}
          >
            <div className="mb-3">
              <p className="text-sm font-medium text-foreground">Trace graph</p>
              <p className="text-xs text-muted-foreground">
                Top-down retrieval flow for the selected assistant turn.
              </p>
            </div>
            {graphPane}
          </div>

          <div>
            {showGraph ? (
              <ChatRetrievalInfo
                retrievalInfo={diagnosticsDebug?.retrievalInfo}
                retrievalTrace={diagnosticsDebug?.retrievalTrace}
                selectedStageId={selectedStageId}
                graphMode
              />
            ) : (
              <ChatRetrievalInfo
                retrievalInfo={diagnosticsDebug?.retrievalInfo}
                retrievalTrace={diagnosticsDebug?.retrievalTrace}
                selectedStageId={undefined}
              />
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}

function SearchDiagnosticsPanel({
  search,
  showGraph,
  onShowGraph,
  onHideGraph,
  selectedStageId,
  graphPane,
}: {
  search: DocumentSearchResponse
  showGraph: boolean
  onShowGraph: () => void
  onHideGraph: () => void
  selectedStageId?: string
  graphPane: ReactNode
}) {
  if (!search.retrievalTrace) {
    return (
      <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
        Diagnostics are unavailable for this search.
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-foreground">Diagnostics</p>
          <p className="text-xs text-muted-foreground">
            Shared retrieval diagnostics for this search run.
          </p>
        </div>
        <ActionButton
          type="button"
          size="sm"
          theme="yellow"
          className="h-9 px-4 text-sm"
          onClick={showGraph ? onHideGraph : onShowGraph}
        >
          {showGraph ? 'Hide graph' : 'Show graph'}
        </ActionButton>
      </div>

      <div
        className="grid gap-4 overflow-hidden"
        style={{
          gridTemplateColumns: showGraph ? 'minmax(380px,1fr) minmax(0,1.1fr)' : '0px minmax(0,1fr)',
          transition: 'grid-template-columns 300ms ease',
        }}
      >
        <div
          className="overflow-hidden rounded-xl border border-border/70 bg-background/60 p-4"
          style={{
            opacity: showGraph ? 1 : 0,
            transform: showGraph ? 'translateX(0)' : 'translateX(12px)',
            transition: 'opacity 300ms ease, transform 300ms ease',
            pointerEvents: showGraph ? 'auto' : 'none',
          }}
        >
          <div className="mb-3">
            <p className="text-sm font-medium text-foreground">Trace graph</p>
            <p className="text-xs text-muted-foreground">
              Top-down retrieval flow for this search run.
            </p>
          </div>
          {graphPane}
        </div>

        <div>
          {showGraph ? (
            <ChatRetrievalInfo
              retrievalInfo={search.retrievalTrace.summary}
              retrievalTrace={search.retrievalTrace}
              selectedStageId={selectedStageId}
              graphMode
            />
          ) : (
            <ChatRetrievalInfo
              retrievalInfo={search.retrievalTrace.summary}
              retrievalTrace={search.retrievalTrace}
              selectedStageId={undefined}
            />
          )}
        </div>
      </div>
    </div>
  )
}
