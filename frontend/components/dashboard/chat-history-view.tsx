'use client'

import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  DrawerTitle,
} from '@/components/ui/drawer'
import { ActionButton } from '@/components/ui/action-button'
import { Button } from '@/components/ui/button'
import { CopyValueField } from '@/components/ui/copy-value-field'
import { LogoSpinner, Spinner } from '@/components/ui/spinner'
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
import { buildDashboardHref, type DashboardRouteState } from '@/lib/dashboard-routes'
import { formatConversationSource } from '@/lib/history-source'

const HISTORY_PAGE_SIZE = 50
const MESSAGE_WINDOW_SIZE = 50
const HIDDEN_SUPPORT_LABELS = {
  assistant_name: 'Assistant name',
  assistant_role: 'Assistant role',
} as const

const formatDiagnosticLabel = (value: string) => value.replaceAll('_', ' ')

interface HistoryPageSnapshot<T> {
  items: T[]
  total: number
  hasMore: boolean
  nextCursor: string | null
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
  const router = useRouter()
  const conversationCursorByPageRef = useRef(new Map<number, string | null>([[1, null]]))
  const conversationPageCacheRef = useRef(new Map<number, HistoryPageSnapshot<ChatConversationSummary>>())
  const searchCursorByPageRef = useRef(new Map<number, string | null>([[1, null]]))
  const searchPageCacheRef = useRef(new Map<number, HistoryPageSnapshot<DocumentSearchHistoryEntry>>())
  const [filter, setFilter] = useState<HistoryFilter>(routeState.historyFilter ?? 'all')
  const [conversations, setConversations] = useState<ChatConversationSummary[]>([])
  const [conversationTotal, setConversationTotal] = useState(0)
  const [hasConversationNextPage, setHasConversationNextPage] = useState(false)
  const [conversationPage, setConversationPage] = useState(
    routeState.historyFilter === 'chat' ? (routeState.historyPage ?? 1) : 1,
  )
  const [searches, setSearches] = useState<DocumentSearchHistoryEntry[]>([])
  const [searchTotal, setSearchTotal] = useState(0)
  const [hasSearchNextPage, setHasSearchNextPage] = useState(false)
  const [searchPage, setSearchPage] = useState(
    routeState.historyFilter === 'search' ? (routeState.historyPage ?? 1) : 1,
  )
  const [allPage, setAllPage] = useState(
    routeState.historyFilter === 'all' || !routeState.historyFilter ? (routeState.historyPage ?? 1) : 1,
  )
  const [selectedItem, setSelectedItem] = useState<SelectedHistoryItem>(
    routeState.historyItemKind && routeState.historyItemId
      ? { kind: routeState.historyItemKind, id: routeState.historyItemId }
      : null,
  )
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

  useEffect(() => {
    const nextFilter = routeState.historyFilter ?? 'all'
    setFilter(nextFilter)

    const nextPage = routeState.historyPage ?? 1
    if (nextFilter === 'all') {
      setAllPage(nextPage)
    } else if (nextFilter === 'chat') {
      setConversationPage(nextPage)
    } else {
      setSearchPage(nextPage)
    }

    if (routeState.historyItemKind && routeState.historyItemId) {
      setSelectedItem({ kind: routeState.historyItemKind, id: routeState.historyItemId })
      return
    }

    setSelectedItem(null)
  }, [
    routeState.historyFilter,
    routeState.historyItemId,
    routeState.historyItemKind,
    routeState.historyPage,
  ])

  const pushHistoryRoute = useCallback((next: {
    filter?: HistoryFilter
    page?: number
    selectedItem?: SelectedHistoryItem
  }) => {
    const nextFilter = next.filter ?? filter
    const nextPage = next.page ?? (
      nextFilter === 'all'
        ? allPage
        : nextFilter === 'chat'
          ? conversationPage
          : searchPage
    )
    const nextSelectedItem = next.selectedItem === undefined ? selectedItem : next.selectedItem

    router.push(buildDashboardHref(accountId, {
      ...routeState,
      section: 'history',
      historyFilter: nextFilter,
      historyPage: nextPage,
      historyItemKind: nextSelectedItem?.kind,
      historyItemId: nextSelectedItem?.id,
    }))
  }, [
    accountId,
    allPage,
    conversationPage,
    filter,
    routeState,
    router,
    searchPage,
    selectedItem,
  ])

  const resetConversationPagination = useCallback(() => {
    conversationCursorByPageRef.current = new Map([[1, null]])
    conversationPageCacheRef.current = new Map()
  }, [])

  const resetSearchPagination = useCallback(() => {
    searchCursorByPageRef.current = new Map([[1, null]])
    searchPageCacheRef.current = new Map()
  }, [])

  const loadConversationPages = useCallback(async (
    pageCount: number,
    options?: { reset?: boolean },
  ): Promise<HistoryPageSnapshot<ChatConversationSummary>[]> => {
    if (options?.reset) {
      resetConversationPagination()
    }

    const cursorByPage = conversationCursorByPageRef.current
    const pageCache = conversationPageCacheRef.current

    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      if (pageCache.has(pageNumber)) {
        const cached = pageCache.get(pageNumber)
        if (cached && !cursorByPage.has(pageNumber + 1)) {
          cursorByPage.set(pageNumber + 1, cached.nextCursor)
        }
        continue
      }

      const cursor = cursorByPage.get(pageNumber) ?? null
      if (pageNumber > 1 && cursor === null) {
        const previousPage = pageCache.get(pageNumber - 1)
        const emptySnapshot: HistoryPageSnapshot<ChatConversationSummary> = {
          items: [],
          total: previousPage?.total ?? 0,
          hasMore: false,
          nextCursor: null,
        }
        pageCache.set(pageNumber, emptySnapshot)
        continue
      }

      const response = await chatApi.listHistory({
        limit: HISTORY_PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
      })
      const snapshot: HistoryPageSnapshot<ChatConversationSummary> = {
        items: response.conversations,
        total: response.total,
        hasMore: response.hasMore,
        nextCursor: response.nextCursor,
      }

      pageCache.set(pageNumber, snapshot)
      cursorByPage.set(pageNumber + 1, response.nextCursor)
    }

    return Array.from({ length: pageCount }, (_, index) => (
      pageCache.get(index + 1) ?? { items: [], total: 0, hasMore: false, nextCursor: null }
    ))
  }, [resetConversationPagination])

  const loadSearchPages = useCallback(async (
    pageCount: number,
    options?: { reset?: boolean },
  ): Promise<HistoryPageSnapshot<DocumentSearchHistoryEntry>[]> => {
    if (options?.reset) {
      resetSearchPagination()
    }

    const cursorByPage = searchCursorByPageRef.current
    const pageCache = searchPageCacheRef.current

    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      if (pageCache.has(pageNumber)) {
        const cached = pageCache.get(pageNumber)
        if (cached && !cursorByPage.has(pageNumber + 1)) {
          cursorByPage.set(pageNumber + 1, cached.nextCursor)
        }
        continue
      }

      const cursor = cursorByPage.get(pageNumber) ?? null
      if (pageNumber > 1 && cursor === null) {
        const previousPage = pageCache.get(pageNumber - 1)
        const emptySnapshot: HistoryPageSnapshot<DocumentSearchHistoryEntry> = {
          items: [],
          total: previousPage?.total ?? 0,
          hasMore: false,
          nextCursor: null,
        }
        pageCache.set(pageNumber, emptySnapshot)
        continue
      }

      const response = await documentsApi.listSearchHistory({
        limit: HISTORY_PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
      })
      const snapshot: HistoryPageSnapshot<DocumentSearchHistoryEntry> = {
        items: response.searches,
        total: response.total,
        hasMore: response.hasMore,
        nextCursor: response.nextCursor,
      }

      pageCache.set(pageNumber, snapshot)
      cursorByPage.set(pageNumber + 1, response.nextCursor)
    }

    return Array.from({ length: pageCount }, (_, index) => (
      pageCache.get(index + 1) ?? { items: [], total: 0, hasMore: false, nextCursor: null }
    ))
  }, [resetSearchPagination])

  const loadHistory = useCallback(async () => {
    setIsListLoading(true)
    setListError(null)

    const [chatResult, searchResult] = await Promise.allSettled([
      filter === 'search'
        ? Promise.resolve<HistoryPageSnapshot<ChatConversationSummary>[]>([])
        : loadConversationPages(filter === 'all' ? allPage : conversationPage),
      filter === 'chat'
        ? Promise.resolve<HistoryPageSnapshot<DocumentSearchHistoryEntry>[]>([])
        : loadSearchPages(filter === 'all' ? allPage : searchPage),
    ])

    if (chatResult.status === 'fulfilled') {
      const loadedConversations = chatResult.value.flatMap((page) => page.items)
      const lastChatPage = chatResult.value.at(-1)
      setConversations(loadedConversations)
      setConversationTotal(lastChatPage?.total ?? 0)
      setHasConversationNextPage(lastChatPage?.hasMore ?? false)
    } else {
      setConversations([])
      setConversationTotal(0)
      setHasConversationNextPage(false)
    }

    if (searchResult.status === 'fulfilled') {
      const loadedSearches = searchResult.value.flatMap((page) => page.items)
      const lastSearchPage = searchResult.value.at(-1)
      setSearches(loadedSearches)
      setSearchTotal(lastSearchPage?.total ?? 0)
      setHasSearchNextPage(lastSearchPage?.hasMore ?? false)
    } else {
      setSearches([])
      setSearchTotal(0)
      setHasSearchNextPage(false)
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
  }, [allPage, conversationPage, filter, loadConversationPages, loadSearchPages, searchPage])

  useEffect(() => {
    void loadHistory()
  }, [loadHistory, accountId])

  useEffect(() => {
    resetConversationPagination()
    resetSearchPagination()
    void loadHistory()
  }, [accountId, loadHistory, resetConversationPagination, resetSearchPagination, routeState.workspaceId])

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
        if (
          error &&
          typeof error === 'object' &&
          'error' in error &&
          error.error &&
          typeof error.error === 'object' &&
          'code' in error.error &&
          error.error.code === 'not_found'
        ) {
          setSelectedItem(null)
          pushHistoryRoute({ selectedItem: null })
        }
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
  }, [pushHistoryRoute, selectedItem])

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
  const allHasNextPage = hasConversationNextPage || hasSearchNextPage

  useEffect(() => {
    const activePage = filter === 'all' ? allPage : filter === 'chat' ? conversationPage : searchPage
    const activeTotalPages = filter === 'all'
      ? allTotalPages
      : filter === 'chat'
        ? conversationTotalPages
        : searchTotalPages

    if (activePage <= activeTotalPages) {
      return
    }

    const nextPage = activeTotalPages
    if (filter === 'all') {
      setAllPage(nextPage)
    } else if (filter === 'chat') {
      setConversationPage(nextPage)
    } else {
      setSearchPage(nextPage)
    }

    router.replace(buildDashboardHref(accountId, {
      ...routeState,
      section: 'history',
      historyFilter: filter,
      historyPage: nextPage,
      historyItemKind: selectedItem?.kind,
      historyItemId: selectedItem?.id,
    }))
  }, [
    accountId,
    allPage,
    allTotalPages,
    conversationPage,
    conversationTotalPages,
    filter,
    routeState,
    router,
    searchPage,
    searchTotalPages,
    selectedItem?.id,
    selectedItem?.kind,
  ])

  const loadOlderMessages = useCallback(async () => {
    if (
      !selectedItem ||
      selectedItem.kind !== 'chat' ||
      !conversationDetail ||
      !conversationDetail.hasOlderMessages ||
      !conversationDetail.nextCursor
    ) {
      return
    }

    setIsDetailLoading(true)
    setDetailError(null)

    try {
      const older = await chatApi.getHistoryConversation(selectedItem.id, {
        limit: MESSAGE_WINDOW_SIZE,
        ...(conversationDetail.nextCursor ? { cursor: conversationDetail.nextCursor } : {}),
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

  const conversationPageItems = useMemo(() => {
    if (filter !== 'chat') {
      return conversations
    }

    const start = (conversationPage - 1) * HISTORY_PAGE_SIZE
    return conversations.slice(start, start + HISTORY_PAGE_SIZE)
  }, [conversationPage, conversations, filter])

  const searchPageItems = useMemo(() => {
    if (filter !== 'search') {
      return searches
    }

    const start = (searchPage - 1) * HISTORY_PAGE_SIZE
    return searches.slice(start, start + HISTORY_PAGE_SIZE)
  }, [filter, searchPage, searches])

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
        allPage={allPage}
        allTotalPages={allTotalPages}
        onFilterChange={(nextFilter) => {
          setFilter(nextFilter)
          if (nextFilter === 'all') setAllPage(1)
          if (nextFilter === 'chat') setConversationPage(1)
          if (nextFilter === 'search') setSearchPage(1)
          pushHistoryRoute({ filter: nextFilter, page: 1, selectedItem: null })
        }}
        onSelectItem={(item) => {
          setSelectedItem(item)
          pushHistoryRoute({ selectedItem: item })
        }}
        onConversationPageChange={(page) => {
          if (page > conversationPage && !hasConversationNextPage) {
            return
          }
          setConversationPage(page)
          pushHistoryRoute({ filter: 'chat', page })
        }}
        onSearchPageChange={(page) => {
          if (page > searchPage && !hasSearchNextPage) {
            return
          }
          setSearchPage(page)
          pushHistoryRoute({ filter: 'search', page })
        }}
        onAllPageChange={(page) => {
          if (page > allPage && !allHasNextPage) {
            return
          }
          setAllPage(page)
          pushHistoryRoute({ filter: 'all', page })
        }}
        onNavigate={(href) => router.push(href)}
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
