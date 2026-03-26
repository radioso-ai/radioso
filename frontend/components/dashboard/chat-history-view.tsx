'use client'

import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'

import {
  type ChatConversationDetail,
  type ChatConversationSummary,
  type ChatConversationTurn,
  type DocumentDetails,
  type DocumentSearchHistoryEntry,
  type DocumentSearchResponse,
  chatApi,
  documentsApi,
} from '@/lib/api'
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
} from '@/components/ui/drawer'
import { ActionButton } from '@/components/ui/action-button'
import { Button } from '@/components/ui/button'
import { CopyValueField } from '@/components/ui/copy-value-field'
import { Spinner } from '@/components/ui/spinner'
import { ChatRetrievalInfo } from './chat-retrieval-info'
import { ChatRetrievalTraceGraph } from './chat-retrieval-trace-graph'
import { ChatMessageThread } from './chat-message-thread'
import type { CitationOpenResult } from './chat-citations'
import { type WorkspaceOnboardingState } from '@/lib/onboarding'
import { Search, X } from 'lucide-react'
import {
  HistoryFilter,
  HistoryList,
  HistoryListItem,
  SelectedHistoryItem,
} from '@/components/dashboard/history/history-list'
import { HistoryDocumentDialog } from '@/components/dashboard/history/history-document-dialog'
import { MetadataBadges } from '@/components/dashboard/shared/metadata-badges'
import { getApiErrorMessage } from '@/lib/api-error'

const HISTORY_PAGE_SIZE = 50
const MESSAGE_WINDOW_SIZE = 50

export function ChatHistoryView({
  accountId,
  onboarding,
}: {
  accountId: string
  onboarding: WorkspaceOnboardingState
}) {
  const router = useRouter()
  const [filter, setFilter] = useState<HistoryFilter>('all')
  const [conversations, setConversations] = useState<ChatConversationSummary[]>([])
  const [conversationTotal, setConversationTotal] = useState(0)
  const [conversationPage, setConversationPage] = useState(1)
  const [searches, setSearches] = useState<DocumentSearchHistoryEntry[]>([])
  const [searchTotal, setSearchTotal] = useState(0)
  const [searchPage, setSearchPage] = useState(1)
  const [allPage, setAllPage] = useState(1)
  const [selectedItem, setSelectedItem] = useState<SelectedHistoryItem>(null)
  const [conversationDetail, setConversationDetail] = useState<ChatConversationDetail | null>(null)
  const [searchDetail, setSearchDetail] = useState<DocumentSearchResponse | null>(null)
  const [isListLoading, setIsListLoading] = useState(true)
  const [isDetailLoading, setIsDetailLoading] = useState(false)
  const [listError, setListError] = useState<string | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [selectedThreadMessageId, setSelectedThreadMessageId] = useState<string | null>(null)
  const [selectedAssistantMessageId, setSelectedAssistantMessageId] = useState<string | null>(null)
  const [selectedStageId, setSelectedStageId] = useState<string | undefined>(undefined)
  const [showGraph, setShowGraph] = useState(false)
  const [isDocumentDialogOpen, setIsDocumentDialogOpen] = useState(false)
  const [isDocumentLoading, setIsDocumentLoading] = useState(false)
  const [documentDetail, setDocumentDetail] = useState<DocumentDetails | null>(null)
  const [documentError, setDocumentError] = useState<string | null>(null)

  const loadHistory = useCallback(async () => {
    setIsListLoading(true)
    setListError(null)

    const listLimit = filter === 'all' ? allPage * HISTORY_PAGE_SIZE : HISTORY_PAGE_SIZE
    const chatOffset = filter === 'all' ? 0 : (conversationPage - 1) * HISTORY_PAGE_SIZE
    const searchOffset = filter === 'all' ? 0 : (searchPage - 1) * HISTORY_PAGE_SIZE

    const [chatResult, searchResult] = await Promise.allSettled([
      chatApi.listHistory({
        limit: listLimit,
        offset: chatOffset,
      }),
      documentsApi.listSearchHistory({
        limit: listLimit,
        offset: searchOffset,
      }),
    ])

    if (chatResult.status === 'fulfilled') {
      setConversations(chatResult.value.conversations)
      setConversationTotal(chatResult.value.total)
    } else {
      setConversations([])
      setConversationTotal(0)
    }

    if (searchResult.status === 'fulfilled') {
      setSearches(searchResult.value.searches)
      setSearchTotal(searchResult.value.total)
    } else {
      setSearches([])
      setSearchTotal(0)
    }

    const errors: string[] = []
    if (chatResult.status === 'rejected') {
      errors.push(getApiErrorMessage(chatResult.reason, 'Failed to load chat history.'))
    }
    if (searchResult.status === 'rejected') {
      errors.push(getApiErrorMessage(searchResult.reason, 'Failed to load search history.'))
    }

    setListError(errors.length > 0 ? errors.join(' ') : null)
    setIsListLoading(false)
  }, [allPage, conversationPage, filter, searchPage])

  useEffect(() => {
    void loadHistory()
  }, [loadHistory, accountId])

  useEffect(() => {
    if (!selectedItem) {
      setConversationDetail(null)
      setSearchDetail(null)
      setDetailError(null)
      setSelectedThreadMessageId(null)
      setSelectedAssistantMessageId(null)
      setSelectedStageId(undefined)
      setShowGraph(false)
      return
    }

    let isActive = true

    const loadDetail = async () => {
      setIsDetailLoading(true)
      setDetailError(null)
      setConversationDetail(null)
        setSearchDetail(null)

      try {
        if (selectedItem.kind === 'chat') {
          const detail = await chatApi.getHistoryConversation(selectedItem.id, {
            limit: MESSAGE_WINDOW_SIZE,
            offset: 0,
          })
          if (!isActive) {
            return
          }
          setConversationDetail(detail)
          const traceBearingMessage =
            [...detail.messages]
              .reverse()
              .find((message) => message.role === 'assistant' && message.debug) ?? null
          setSelectedThreadMessageId(traceBearingMessage?.id ?? null)
          setSelectedAssistantMessageId(traceBearingMessage?.id ?? null)
          setSelectedStageId(traceBearingMessage?.debug?.retrievalTrace?.stages[0]?.stageId)
          setShowGraph(false)
          return
        }

        const detail = await documentsApi.getSearchHistory(selectedItem.id)
        if (!isActive) {
          return
        }
        setSearchDetail(detail)
        setSelectedStageId(detail.retrievalTrace?.stages[0]?.stageId)
        setShowGraph(false)
      } catch (error) {
        if (!isActive) {
          return
        }
        setDetailError(
          getApiErrorMessage(
            error,
            selectedItem.kind === 'chat'
              ? 'Failed to load conversation details.'
              : 'Failed to load search details.',
          ),
        )
      } finally {
        if (isActive) {
          setIsDetailLoading(false)
        }
      }
    }

    void loadDetail()

    return () => {
      isActive = false
    }
  }, [selectedItem])

  const assistantMessages = useMemo(
    () => conversationDetail?.messages.filter((message) => message.role === 'assistant') ?? [],
    [conversationDetail],
  )

  const selectedThreadMessage = useMemo(
    () => conversationDetail?.messages.find((message) => message.id === selectedThreadMessageId) ?? null,
    [conversationDetail, selectedThreadMessageId],
  )

  const selectedAssistantMessage = useMemo(
    () =>
      assistantMessages.find((message) => message.id === selectedAssistantMessageId) ??
      assistantMessages[assistantMessages.length - 1] ??
      null,
    [assistantMessages, selectedAssistantMessageId],
  )

  const selectedDiagnosticsAssistantMessage = useMemo(() => {
    if (!conversationDetail || !selectedThreadMessage) {
      return selectedAssistantMessage
    }

    if (selectedThreadMessage.role === 'assistant') {
      return selectedThreadMessage
    }

    const messageIndex = conversationDetail.messages.findIndex((message) => message.id === selectedThreadMessage.id)
    if (messageIndex < 0) {
      return null
    }

    return (
      conversationDetail.messages
        .slice(messageIndex + 1)
        .find((message) => message.role === 'assistant') ?? null
    )
  }, [conversationDetail, selectedThreadMessage, selectedAssistantMessage])

  const selectedDiagnosticsDebug =
    selectedDiagnosticsAssistantMessage?.role === 'assistant' ? selectedDiagnosticsAssistantMessage.debug : undefined
  const selectedDiagnosticsTrace = selectedDiagnosticsDebug?.retrievalTrace
  const activeTrace = selectedItem?.kind === 'chat' ? selectedDiagnosticsTrace : searchDetail?.retrievalTrace
  const activeTraceId = activeTrace?.traceId
  const activeInitialStageId = activeTrace?.stages[0]?.stageId

  useEffect(() => {
    setSelectedStageId(activeInitialStageId)
  }, [activeTraceId, activeInitialStageId])

  const handleSelectThreadMessage = useCallback(
    (messageId: string) => {
      if (!conversationDetail) {
        return
      }

      const messageIndex = conversationDetail.messages.findIndex((message) => message.id === messageId)
      if (messageIndex < 0) {
        return
      }

      const clickedMessage = conversationDetail.messages[messageIndex]
      setSelectedThreadMessageId(clickedMessage.id)

      const targetAssistant =
        clickedMessage.role === 'assistant'
          ? clickedMessage
          : conversationDetail.messages
              .slice(messageIndex + 1)
              .find((message) => message.role === 'assistant')

      if (!targetAssistant || targetAssistant.role !== 'assistant') {
        return
      }

      setSelectedAssistantMessageId(targetAssistant.id)
      setSelectedStageId(targetAssistant.debug?.retrievalTrace?.stages[0]?.stageId)
    },
    [conversationDetail],
  )

  const handleOpenCitation = useCallback(async (documentId: string): Promise<CitationOpenResult> => {
    setIsDocumentLoading(true)
    setDocumentError(null)

    try {
      const detail = await documentsApi.getDocument(documentId)
      setDocumentDetail(detail)
      setIsDocumentDialogOpen(true)
      return 'opened'
    } catch (error) {
      setDocumentDetail(null)
      setDocumentError(getApiErrorMessage(error, 'Failed to load document.'))
      setIsDocumentDialogOpen(true)
      if (
        error &&
        typeof error === 'object' &&
        'error' in error &&
        error.error &&
        typeof error.error === 'object' &&
        'code' in error.error &&
        error.error.code === 'not_found'
      ) {
        return 'unavailable'
      }

      return 'error'
    } finally {
      setIsDocumentLoading(false)
    }
  }, [])

  const conversationTotalPages = Math.max(1, Math.ceil(conversationTotal / HISTORY_PAGE_SIZE))
  const searchTotalPages = Math.max(1, Math.ceil(searchTotal / HISTORY_PAGE_SIZE))
  const allTotal = conversationTotal + searchTotal
  const allTotalPages = Math.max(1, Math.ceil(allTotal / HISTORY_PAGE_SIZE))

  const loadOlderMessages = useCallback(async () => {
    if (!selectedItem || selectedItem.kind !== 'chat' || !conversationDetail || !conversationDetail.hasOlderMessages) {
      return
    }

    setIsDetailLoading(true)
    setDetailError(null)

    try {
      const older = await chatApi.getHistoryConversation(selectedItem.id, {
        limit: MESSAGE_WINDOW_SIZE,
        offset: conversationDetail.messages.length,
      })
      setConversationDetail((current) => {
        if (!current) {
          return older
        }
        return {
          ...older,
          messages: [...older.messages, ...current.messages],
        }
      })
    } catch (error) {
      setDetailError(getApiErrorMessage(error, 'Failed to load older messages.'))
    } finally {
      setIsDetailLoading(false)
    }
  }, [conversationDetail, selectedItem])

  const hasAnyHistory = conversationTotal > 0 || searchTotal > 0

  const allHistoryItems = useMemo<HistoryListItem[]>(() => {
    const merged: HistoryListItem[] = [
      ...conversations.map((conversation) => ({
        kind: 'chat' as const,
        id: conversation.id,
        sortAt: conversation.updatedAt,
        conversation,
      })),
      ...searches.map((search) => ({
        kind: 'search' as const,
        id: search.searchId,
        sortAt: search.createdAt,
        search,
      })),
    ].sort((left, right) => new Date(right.sortAt).getTime() - new Date(left.sortAt).getTime())

    const start = (allPage - 1) * HISTORY_PAGE_SIZE
    return merged.slice(start, start + HISTORY_PAGE_SIZE)
  }, [allPage, conversations, searches])

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <HistoryList
        accountId={accountId}
        onboarding={onboarding}
        filter={filter}
        isLoading={isListLoading}
        hasAnyHistory={hasAnyHistory}
        listError={listError}
        conversations={conversations}
        conversationPage={conversationPage}
        conversationTotalPages={conversationTotalPages}
        searches={searches}
        searchPage={searchPage}
        searchTotalPages={searchTotalPages}
        allHistoryItems={allHistoryItems}
        allPage={allPage}
        allTotalPages={allTotalPages}
        onFilterChange={(nextFilter) => {
          setFilter(nextFilter)
          if (nextFilter === 'all') {
            setAllPage(1)
          }
        }}
        onSelectItem={setSelectedItem}
        onConversationPageChange={setConversationPage}
        onSearchPageChange={setSearchPage}
        onAllPageChange={setAllPage}
        onNavigate={(href) => router.push(href)}
      />

      <Drawer
        open={selectedItem !== null}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedItem(null)
            setShowGraph(false)
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
                {selectedItem ? (
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
                ) : null}
                <DrawerDescription className="sr-only">History details panel</DrawerDescription>
              </div>
              <DrawerClose className="shrink-0 rounded-md p-1 text-muted-foreground hover:text-foreground">
                <X className="h-4 w-4" />
              </DrawerClose>
            </div>
          </DrawerHeader>

          <div className="min-h-0 flex-1 overflow-hidden p-4">
            {isDetailLoading ? (
              <div className="flex h-full items-center justify-center">
                <Spinner className="h-6 w-6" />
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
                      <Button type="button" size="sm" variant="outline" onClick={() => void loadOlderMessages()}>
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
                            Detailed retrieval trace unavailable for this assistant turn.
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
                Select a history entry to inspect it.
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
        onOpenChange={(open) => {
          setIsDocumentDialogOpen(open)
          if (!open) {
            setDocumentDetail(null)
            setDocumentError(null)
          }
        }}
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
