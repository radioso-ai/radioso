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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { CopyValueField } from '@/components/ui/copy-value-field'
import { ChatRetrievalInfo } from './chat-retrieval-info'
import { ChatRetrievalTraceGraph } from './chat-retrieval-trace-graph'
import { ChatMessageThread } from './chat-message-thread'
import type { CitationOpenResult } from './chat-citations'
import { buildAccountRoute } from '@/lib/dashboard-routes'
import { type WorkspaceOnboardingState } from '@/lib/onboarding'
import { FileText, History, MessageSquareText, Search, X } from 'lucide-react'
import { Textarea } from '@/components/ui/textarea'

const formatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'medium',
})
const HISTORY_PAGE_SIZE = 50
const MESSAGE_WINDOW_SIZE = 50

type HistoryFilter = 'all' | 'chat' | 'search'
type SelectedHistoryItem =
  | { kind: 'chat'; id: string }
  | { kind: 'search'; id: string }
  | null

const formatTimestamp = (value: string) => formatter.format(new Date(value))

const getErrorMessage = (error: unknown, fallback: string): string => {
  if (
    error &&
    typeof error === 'object' &&
    'error' in error &&
    error.error &&
    typeof error.error === 'object' &&
    'message' in error.error &&
    typeof error.error.message === 'string'
  ) {
    return error.error.message
  }

  if (error instanceof Error && error.message) {
    return error.message
  }

  return fallback
}

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

    const [chatResult, searchResult] = await Promise.allSettled([
      chatApi.listHistory({
        limit: HISTORY_PAGE_SIZE,
        offset: (conversationPage - 1) * HISTORY_PAGE_SIZE,
      }),
      documentsApi.listSearchHistory({
        limit: HISTORY_PAGE_SIZE,
        offset: (searchPage - 1) * HISTORY_PAGE_SIZE,
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
      errors.push(getErrorMessage(chatResult.reason, 'Failed to load chat history.'))
    }
    if (searchResult.status === 'rejected') {
      errors.push(getErrorMessage(searchResult.reason, 'Failed to load search history.'))
    }

    setListError(errors.length > 0 ? errors.join(' ') : null)
    setIsListLoading(false)
  }, [conversationPage, searchPage])

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
          getErrorMessage(
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
      setDocumentError(getErrorMessage(error, 'Failed to load document.'))
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
      setDetailError(getErrorMessage(error, 'Failed to load older messages.'))
    } finally {
      setIsDetailLoading(false)
    }
  }, [conversationDetail, selectedItem])

  const hasAnyHistory = conversationTotal > 0 || searchTotal > 0

  const renderSectionPagination = (
    page: number,
    totalPages: number,
    onPrevious: () => void,
    onNext: () => void,
  ) => (
    totalPages > 1 ? (
      <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-background/60 px-3 py-2 text-sm">
        <span className="text-muted-foreground">Page {page} of {totalPages}</span>
        <div className="flex items-center gap-2">
          <Button type="button" size="sm" variant="outline" onClick={onPrevious} disabled={page === 1}>
            Previous
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={onNext} disabled={page === totalPages}>
            Next
          </Button>
        </div>
      </div>
    ) : null
  )

  const renderConversationCard = (conversation: ChatConversationSummary) => (
    <button
      key={`chat-${conversation.id}`}
      type="button"
      onClick={() => setSelectedItem({ kind: 'chat', id: conversation.id })}
      className="w-full rounded-xl border border-border bg-card p-4 text-left transition hover:border-primary/40 hover:bg-accent/40"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">
              Chat
            </span>
            <p className="font-medium text-foreground">
              {conversation.preview || 'Untitled conversation'}
            </p>
          </div>
          <p className="text-xs text-muted-foreground">{conversation.id}</p>
        </div>
        <p className="text-xs text-muted-foreground">
          Updated {formatTimestamp(conversation.updatedAt)}
        </p>
      </div>
      <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
        {conversation.sourceChannel === 'anonymous' && (
          <span className="rounded-full bg-amber-500/15 px-2.5 py-1 text-amber-700 dark:text-amber-400">
            Anonymous
          </span>
        )}
        <span className="rounded-full bg-muted px-2.5 py-1">
          {conversation.messageCount} messages
        </span>
        <span className="rounded-full bg-muted px-2.5 py-1">
          {conversation.userMessageCount} user
        </span>
        <span className="rounded-full bg-muted px-2.5 py-1">
          {conversation.assistantMessageCount} assistant
        </span>
      </div>
    </button>
  )

  const renderSearchCard = (search: DocumentSearchHistoryEntry) => (
    <button
      key={`search-${search.searchId}`}
      type="button"
      onClick={() => setSelectedItem({ kind: 'search', id: search.searchId })}
      className="w-full rounded-xl border border-border bg-card p-4 text-left transition hover:border-primary/40 hover:bg-accent/40"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">
              Search
            </span>
            <p className="font-medium text-foreground">{search.query}</p>
          </div>
          <p className="text-xs text-muted-foreground">{search.searchId}</p>
        </div>
        <p className="text-xs text-muted-foreground">
          Searched {formatTimestamp(search.createdAt)}
        </p>
      </div>
      <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
        <span className="rounded-full bg-muted px-2.5 py-1">
          {search.resultCount} document{search.resultCount === 1 ? '' : 's'} retrieved
        </span>
        {search.traceAvailable ? (
          <span className="rounded-full bg-muted px-2.5 py-1">Diagnostics available</span>
        ) : null}
      </div>
    </button>
  )

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="shrink-0 border-b border-border px-6 py-4">
        <h1 className="text-lg font-medium text-foreground">History</h1>
        <p className="text-sm text-muted-foreground">
          Review past chats and searches. Retrieval diagnostics live here.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          {([
            { value: 'all', label: 'All' },
            { value: 'chat', label: 'Chats' },
            { value: 'search', label: 'Searches' },
          ] as const).map((option) => (
            <Button
              key={option.value}
              type="button"
              size="sm"
              variant={filter === option.value ? 'default' : 'outline'}
              onClick={() => setFilter(option.value)}
            >
              {option.label}
            </Button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        {isListLoading ? (
          <div className="flex h-full items-center justify-center">
            <Spinner className="h-6 w-6" />
          </div>
        ) : !hasAnyHistory ? (
          <div className="space-y-6">
            {listError ? (
              <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
                {listError}
              </div>
            ) : null}
            <div className="flex h-full flex-col items-center justify-center text-center">
              <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
                <History className="h-5 w-5 text-primary" />
              </div>
              <h2 className="text-lg font-medium text-foreground">No history yet</h2>
              <p className="mt-1 max-w-md text-sm text-muted-foreground">
                {filter === 'chat'
                  ? onboarding.hasReadyDocuments
                    ? 'Your workspace is ready. Ask the first question and it will appear here.'
                    : 'Load content first, then ask one question. Conversation history will appear here after that.'
                  : filter === 'search'
                    ? 'Document searches will appear here after someone runs a search.'
                    : onboarding.hasReadyDocuments
                      ? 'Your workspace is ready. Ask the first question or run a document search to start building history.'
                      : 'Load content first, then ask one question or run a document search. History will appear here after that.'}
              </p>
            </div>
            <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
              {filter !== 'search' && onboarding.hasReadyDocuments ? (
                <Button size="sm" onClick={() => router.push(buildAccountRoute(accountId, 'chat'))}>
                  <MessageSquareText className="mr-2 h-4 w-4" />
                  Ask first question
                </Button>
              ) : null}
              {(filter === 'chat' || filter === 'all') && !onboarding.hasReadyDocuments ? (
                <Button size="sm" onClick={() => router.push(buildAccountRoute(accountId, 'documents'))}>
                  <FileText className="mr-2 h-4 w-4" />
                  Open documents
                </Button>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="mx-auto max-w-4xl space-y-3">
            {listError ? (
              <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
                {listError}
              </div>
            ) : null}
            {filter !== 'search' ? (
              <section className="space-y-3">
                {filter === 'all' ? (
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h2 className="text-sm font-medium text-foreground">Recent Chats</h2>
                      <p className="text-xs text-muted-foreground">{conversationTotal} total</p>
                    </div>
                    {renderSectionPagination(
                      conversationPage,
                      conversationTotalPages,
                      () => setConversationPage((page) => Math.max(1, page - 1)),
                      () => setConversationPage((page) => Math.min(conversationTotalPages, page + 1)),
                    )}
                  </div>
                ) : null}
                {conversations.length === 0 ? (
                  filter === 'chat' ? (
                    <div className="rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground">
                      No saved chats on this page.
                    </div>
                  ) : null
                ) : (
                  conversations.map(renderConversationCard)
                )}
                {filter === 'chat'
                  ? renderSectionPagination(
                      conversationPage,
                      conversationTotalPages,
                      () => setConversationPage((page) => Math.max(1, page - 1)),
                      () => setConversationPage((page) => Math.min(conversationTotalPages, page + 1)),
                    )
                  : null}
              </section>
            ) : null}

            {filter === 'all' && searches.length > 0 ? <div className="border-t border-border/60 pt-4" /> : null}

            {filter !== 'chat' ? (
              <section className="space-y-3">
                {filter === 'all' ? (
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h2 className="text-sm font-medium text-foreground">Recent Searches</h2>
                      <p className="text-xs text-muted-foreground">{searchTotal} total</p>
                    </div>
                    {renderSectionPagination(
                      searchPage,
                      searchTotalPages,
                      () => setSearchPage((page) => Math.max(1, page - 1)),
                      () => setSearchPage((page) => Math.min(searchTotalPages, page + 1)),
                    )}
                  </div>
                ) : null}
                {searches.length === 0 ? (
                  filter === 'search' ? (
                    <div className="rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground">
                      No saved searches on this page.
                    </div>
                  ) : null
                ) : (
                  searches.map(renderSearchCard)
                )}
                {filter === 'search'
                  ? renderSectionPagination(
                      searchPage,
                      searchTotalPages,
                      () => setSearchPage((page) => Math.max(1, page - 1)),
                      () => setSearchPage((page) => Math.min(searchTotalPages, page + 1)),
                    )
                  : null}
              </section>
            ) : null}
          </div>
        )}
      </div>

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
                              <div className="flex flex-wrap gap-1">
                                {Object.entries(result.metadata ?? {}).map(([key, value]) => (
                                  <span
                                    key={key}
                                    className="inline-flex items-center rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
                                  >
                                    {key}: {String(value)}
                                  </span>
                                ))}
                              </div>
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

      <Dialog
        open={isDocumentDialogOpen}
        onOpenChange={(open) => {
          setIsDocumentDialogOpen(open)
          if (!open) {
            setDocumentDetail(null)
            setDocumentError(null)
          }
        }}
      >
        <DialogContent className="flex h-[min(85vh,760px)] max-h-[85vh] flex-col overflow-hidden sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>View Document</DialogTitle>
            <DialogDescription>
              Review the document without leaving the current history view.
            </DialogDescription>
          </DialogHeader>
          {isDocumentLoading ? (
            <div className="flex flex-1 items-center justify-center">
              <Spinner className="h-6 w-6" />
            </div>
          ) : documentError ? (
            <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
              {documentError}
            </div>
          ) : documentDetail ? (
            <div className="mt-4 flex min-h-0 flex-1 flex-col overflow-hidden">
              <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1">
                <div className="space-y-2">
                  <Label htmlFor="historyDocumentTitle">Title</Label>
                  <div
                    id="historyDocumentTitle"
                    className="rounded-md border border-input bg-muted/30 px-3 py-2 text-sm text-foreground"
                  >
                    {documentDetail.title}
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="historyDocumentContent">Content</Label>
                  <Textarea
                    id="historyDocumentContent"
                    value={documentDetail.content}
                    readOnly
                    className="min-h-[320px] resize-none overflow-y-auto [field-sizing:fixed]"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="historyDocumentMetadata">Metadata</Label>
                  <Textarea
                    id="historyDocumentMetadata"
                    value={
                      Object.keys(documentDetail.metadata ?? {}).length > 0
                        ? JSON.stringify(documentDetail.metadata, null, 2)
                        : '{}'
                    }
                    readOnly
                    className="min-h-[120px] resize-none font-mono text-sm"
                  />
                </div>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
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
