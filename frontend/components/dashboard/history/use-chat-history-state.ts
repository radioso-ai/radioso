'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'

import {
  chatApi,
  documentsApi,
  type ChatConversationDetail,
  type ChatConversationSummary,
  type ChatConversationTurn,
  type ContactHistoryDetailResponse,
  type ContactHistorySummary,
  type DocumentDetails,
  type DocumentSearchHistoryEntry,
  type DocumentSearchResponse,
  type HistoryItem,
} from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { buildDashboardHref, type DashboardRouteState } from '@/lib/dashboard-routes'
import type { CitationOpenResult } from '@/components/dashboard/chat-citations'
import type { HistoryFilter, HistoryListItem, SelectedHistoryItem } from './history-list'

export const HISTORY_PAGE_SIZE = 50
export const MESSAGE_WINDOW_SIZE = 50

const buildHistoryLoadKey = (workspaceId: string | undefined, filter: HistoryFilter, page: number) =>
  `${workspaceId ?? ''}:${filter}:${page}`

type PushHistoryRoute = (next: {
  filter?: HistoryFilter
  page?: number
  selectedItem?: SelectedHistoryItem
}) => void

export function useHistoryListState({
  accountId,
  routeState,
}: {
  accountId: string
  routeState: DashboardRouteState
}) {
  const router = useRouter()
  const [filter, setFilter] = useState<HistoryFilter>(routeState.historyFilter ?? 'all')
  const [historyItems, setHistoryItems] = useState<HistoryItem[]>([])
  const [historyItemsTotal, setHistoryItemsTotal] = useState(0)
  const [hasHistoryItemsNextPage, setHasHistoryItemsNextPage] = useState(false)
  const [conversations, setConversations] = useState<ChatConversationSummary[]>([])
  const [conversationTotal, setConversationTotal] = useState(0)
  const [hasConversationNextPage, setHasConversationNextPage] = useState(false)
  const [conversationPage, setConversationPage] = useState(
    routeState.historyFilter === 'chat' ? (routeState.historyPage ?? 1) : 1,
  )
  const [searches, setSearches] = useState<DocumentSearchHistoryEntry[]>([])
  const [searchTotal, setSearchTotal] = useState(0)
  const [hasSearchNextPage, setHasSearchNextPage] = useState(false)
  const [contacts, setContacts] = useState<ContactHistorySummary[]>([])
  const [contactTotal, setContactTotal] = useState(0)
  const [hasContactNextPage, setHasContactNextPage] = useState(false)
  const [searchPage, setSearchPage] = useState(
    routeState.historyFilter === 'search' ? (routeState.historyPage ?? 1) : 1,
  )
  const [allPage, setAllPage] = useState(
    routeState.historyFilter === 'all' || !routeState.historyFilter ? (routeState.historyPage ?? 1) : 1,
  )
  const [contactPage, setContactPage] = useState(
    routeState.historyFilter === 'contact' ? (routeState.historyPage ?? 1) : 1,
  )
  const [selectedItem, setSelectedItem] = useState<SelectedHistoryItem>(
    routeState.historyItemKind && routeState.historyItemId
      ? { kind: routeState.historyItemKind, id: routeState.historyItemId }
      : null,
  )
  const [isListLoading, setIsListLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)
  const [loadedHistoryKey, setLoadedHistoryKey] = useState<string | null>(null)

  useEffect(() => {
    const nextFilter = routeState.historyFilter ?? 'all'
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Syncs local history controls from the current URL route.
    setFilter(nextFilter)

    const nextPage = routeState.historyPage ?? 1
    if (nextFilter === 'all') {
      setAllPage(nextPage)
    } else if (nextFilter === 'chat') {
      setConversationPage(nextPage)
    } else if (nextFilter === 'search') {
      setSearchPage(nextPage)
    } else {
      setContactPage(nextPage)
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

  const pushHistoryRoute = useCallback<PushHistoryRoute>((next) => {
    const nextFilter = next.filter ?? filter
    const nextPage = next.page ?? (
      nextFilter === 'all'
        ? allPage
        : nextFilter === 'chat'
          ? conversationPage
          : nextFilter === 'search'
            ? searchPage
            : contactPage
    )
    const nextSelectedItem = next.selectedItem === undefined ? selectedItem : next.selectedItem

    router.push(buildDashboardHref(accountId, {
      ...routeState,
      section: 'activity',
      historyFilter: nextFilter,
      historyPage: nextPage,
      historyItemKind: nextSelectedItem?.kind,
      historyItemId: nextSelectedItem?.id,
    }))
  }, [
    accountId,
    allPage,
    contactPage,
    conversationPage,
    filter,
    routeState,
    router,
    searchPage,
    selectedItem,
  ])

  const loadHistory = useCallback(async () => {
    setIsListLoading(true)
    setListError(null)
    const page = filter === 'all' ? allPage : filter === 'chat' ? conversationPage : filter === 'search' ? searchPage : contactPage
    const loadKey = buildHistoryLoadKey(routeState.workspaceId, filter, page)

    try {
      if (filter === 'all') {
        const response = await chatApi.listHistory({
          limit: HISTORY_PAGE_SIZE,
          offset: (allPage - 1) * HISTORY_PAGE_SIZE,
        })
        setHistoryItems(response.items)
        setHistoryItemsTotal(response.total)
        setHasHistoryItemsNextPage(response.hasMore)
        setLoadedHistoryKey(loadKey)
        return
      }

      if (filter === 'chat') {
        const response = await chatApi.listChatHistory({
          limit: HISTORY_PAGE_SIZE,
          offset: (conversationPage - 1) * HISTORY_PAGE_SIZE,
        })
        setConversations(response.conversations)
        setConversationTotal(response.total)
        setHasConversationNextPage(response.hasMore)
        setLoadedHistoryKey(loadKey)
        return
      }

      if (filter === 'contact') {
        const response = await chatApi.listContactHistory({
          limit: HISTORY_PAGE_SIZE,
          offset: (contactPage - 1) * HISTORY_PAGE_SIZE,
        })
        setContacts(response.contacts)
        setContactTotal(response.total)
        setHasContactNextPage(response.hasMore)
        setLoadedHistoryKey(loadKey)
        return
      }

      const response = await chatApi.listSearchHistory({
        limit: HISTORY_PAGE_SIZE,
        offset: (searchPage - 1) * HISTORY_PAGE_SIZE,
      })
      setSearches(response.searches)
      setSearchTotal(response.total)
      setHasSearchNextPage(response.hasMore)
      setLoadedHistoryKey(loadKey)
    } catch (error) {
      if (filter === 'all') {
        setHistoryItems([])
        setHistoryItemsTotal(0)
        setHasHistoryItemsNextPage(false)
      } else if (filter === 'chat') {
        setConversations([])
        setConversationTotal(0)
        setHasConversationNextPage(false)
      } else if (filter === 'search') {
        setSearches([])
        setSearchTotal(0)
        setHasSearchNextPage(false)
      } else {
        setContacts([])
        setContactTotal(0)
        setHasContactNextPage(false)
      }

      setListError(
        getApiErrorMessage(
          error,
          filter === 'search'
            ? 'Failed to load search activity.'
            : filter === 'chat'
              ? 'Failed to load chat activity.'
              : filter === 'contact'
                ? 'Failed to load contact activity.'
              : 'Failed to load activity.',
        ),
      )
    } finally {
      setIsListLoading(false)
    }
  }, [allPage, contactPage, conversationPage, filter, routeState.workspaceId, searchPage])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- History view fetches the current page after route/filter changes.
    void loadHistory()
  }, [loadHistory, accountId, routeState.workspaceId])

  const conversationTotalPages = Math.max(1, Math.ceil(conversationTotal / HISTORY_PAGE_SIZE))
  const searchTotalPages = Math.max(1, Math.ceil(searchTotal / HISTORY_PAGE_SIZE))
  const contactTotalPages = Math.max(1, Math.ceil(contactTotal / HISTORY_PAGE_SIZE))
  const allTotal = historyItemsTotal
  const allTotalPages = Math.max(1, Math.ceil(allTotal / HISTORY_PAGE_SIZE))
  const allHasNextPage = hasHistoryItemsNextPage

  useEffect(() => {
    const activePage = filter === 'all' ? allPage : filter === 'chat' ? conversationPage : filter === 'search' ? searchPage : contactPage
    const activeLoadKey = buildHistoryLoadKey(routeState.workspaceId, filter, activePage)
    const activeTotalPages = filter === 'all'
      ? allTotalPages
      : filter === 'chat'
        ? conversationTotalPages
        : filter === 'search'
          ? searchTotalPages
          : contactTotalPages

    if (loadedHistoryKey !== activeLoadKey) {
      return
    }

    if (activePage <= activeTotalPages) {
      return
    }

    const nextPage = activeTotalPages
    if (filter === 'all') {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Clamps local pagination after result totals shrink.
      setAllPage(nextPage)
    } else if (filter === 'chat') {
      setConversationPage(nextPage)
    } else if (filter === 'search') {
      setSearchPage(nextPage)
    } else {
      setContactPage(nextPage)
    }

    router.replace(buildDashboardHref(accountId, {
      ...routeState,
      section: 'activity',
      historyFilter: filter,
      historyPage: nextPage,
      historyItemKind: selectedItem?.kind,
      historyItemId: selectedItem?.id,
    }))
  }, [
    accountId,
    allPage,
    allTotalPages,
    contactPage,
    contactTotalPages,
    conversationPage,
    conversationTotalPages,
    filter,
    loadedHistoryKey,
    routeState,
    router,
    searchPage,
    searchTotalPages,
    selectedItem?.id,
    selectedItem?.kind,
  ])

  const hasAnyHistory =
    filter === 'all'
      ? historyItemsTotal > 0
      : filter === 'chat'
        ? conversationTotal > 0
        : filter === 'search'
          ? searchTotal > 0
          : contactTotal > 0

  const allHistoryItems: HistoryListItem[] = historyItems

  return {
    filter,
    isListLoading,
    hasAnyHistory,
    listError,
    conversations,
    conversationTotal,
    conversationPage,
    conversationTotalPages,
    searches,
    searchTotal,
    searchPage,
    searchTotalPages,
    contacts,
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
    onFilterChange: (nextFilter: HistoryFilter) => {
      setFilter(nextFilter)
      if (nextFilter === 'all') setAllPage(1)
      if (nextFilter === 'chat') setConversationPage(1)
      if (nextFilter === 'search') setSearchPage(1)
      if (nextFilter === 'contact') setContactPage(1)
      pushHistoryRoute({ filter: nextFilter, page: 1, selectedItem: null })
    },
    onSelectItem: (item: SelectedHistoryItem) => {
      setSelectedItem(item)
      pushHistoryRoute({ selectedItem: item })
    },
    onConversationPageChange: (page: number) => {
      if (page > conversationPage && !hasConversationNextPage) {
        return
      }
      setConversationPage(page)
      pushHistoryRoute({ filter: 'chat', page })
    },
    onSearchPageChange: (page: number) => {
      if (page > searchPage && !hasSearchNextPage) {
        return
      }
      setSearchPage(page)
      pushHistoryRoute({ filter: 'search', page })
    },
    onContactPageChange: (page: number) => {
      if (page > contactPage && !hasContactNextPage) {
        return
      }
      setContactPage(page)
      pushHistoryRoute({ filter: 'contact', page })
    },
    onAllPageChange: (page: number) => {
      if (page > allPage && !allHasNextPage) {
        return
      }
      setAllPage(page)
      pushHistoryRoute({ filter: 'all', page })
    },
    onNavigate: (href: string) => router.push(href),
  }
}

const isNotFoundError = (error: unknown) =>
  error &&
  typeof error === 'object' &&
  'error' in error &&
  error.error &&
  typeof error.error === 'object' &&
  'code' in error.error &&
  error.error.code === 'not_found'

export function useHistoryDetailState({
  selectedItem,
  setSelectedItem,
  pushHistoryRoute,
}: {
  selectedItem: SelectedHistoryItem
  setSelectedItem: (item: SelectedHistoryItem) => void
  pushHistoryRoute: PushHistoryRoute
}) {
  const [conversationDetail, setConversationDetail] = useState<ChatConversationDetail | null>(null)
  const [searchDetail, setSearchDetail] = useState<DocumentSearchResponse | null>(null)
  const [contactDetail, setContactDetail] = useState<ContactHistoryDetailResponse | null>(null)
  const [isDetailLoading, setIsDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [selectedThreadMessageId, setSelectedThreadMessageId] = useState<string | null>(null)
  const [selectedAssistantMessageId, setSelectedAssistantMessageId] = useState<string | null>(null)
  const [selectedStageId, setSelectedStageId] = useState<string | undefined>(undefined)
  const [showGraph, setShowGraph] = useState(false)

  useEffect(() => {
    if (!selectedItem) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Closing the drawer clears its detail state.
      setConversationDetail(null)
      setSearchDetail(null)
      setContactDetail(null)
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
      setContactDetail(null)

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

        if (selectedItem.kind === 'contact') {
          const detail = await chatApi.getContactHistory(selectedItem.id, {
            limit: MESSAGE_WINDOW_SIZE,
          })
          if (!isActive) {
            return
          }
          setContactDetail(detail)
          setConversationDetail(detail.conversation)
          const selectedAssistant =
            detail.contact.assistantMessageId
              ? detail.conversation.messages.find((message) => message.id === detail.contact.assistantMessageId) ?? null
              : [...detail.conversation.messages].reverse().find((message) => message.role === 'assistant') ?? null
          setSelectedThreadMessageId(selectedAssistant?.id ?? null)
          setSelectedAssistantMessageId(selectedAssistant?.role === 'assistant' ? selectedAssistant.id : null)
          setSelectedStageId(selectedAssistant?.role === 'assistant' ? selectedAssistant.debug?.retrievalTrace?.stages[0]?.stageId : undefined)
          setShowGraph(false)
          return
        }

        const detail = await chatApi.getSearchHistory(selectedItem.id)
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
              : selectedItem.kind === 'contact'
                ? 'Failed to load contact request details.'
              : 'Failed to load search details.',
          ),
        )
        if (isNotFoundError(error)) {
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
  }, [pushHistoryRoute, selectedItem, setSelectedItem])

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
  const activeTrace = selectedItem?.kind === 'chat' || selectedItem?.kind === 'contact' ? selectedDiagnosticsTrace : searchDetail?.retrievalTrace
  const activeTraceId = activeTrace?.traceId
  const activeInitialStageId = activeTrace?.stages[0]?.stageId

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Active trace changes reset the selected diagnostics stage.
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

  const loadOlderMessages = useCallback(async () => {
    if (
      !selectedItem ||
      (selectedItem.kind !== 'chat' && selectedItem.kind !== 'contact') ||
      !conversationDetail ||
      !conversationDetail.hasOlderMessages ||
      !conversationDetail.nextCursor
    ) {
      return
    }

    setIsDetailLoading(true)
    setDetailError(null)

    try {
      const older = selectedItem.kind === 'contact'
        ? (await chatApi.getContactHistory(selectedItem.id, {
            limit: MESSAGE_WINDOW_SIZE,
            ...(conversationDetail.nextCursor ? { cursor: conversationDetail.nextCursor } : {}),
          })).conversation
        : await chatApi.getHistoryConversation(selectedItem.id, {
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

  return {
    conversationDetail,
    searchDetail,
    contactDetail,
    isDetailLoading,
    detailError,
    selectedThreadMessage,
    selectedThreadMessageId,
    selectedDiagnosticsAssistantMessage: selectedDiagnosticsAssistantMessage as ChatConversationTurn | null,
    selectedDiagnosticsTrace,
    activeInitialStageId,
    selectedStageId,
    setSelectedStageId,
    showGraph,
    setShowGraph,
    handleSelectThreadMessage,
    loadOlderMessages,
  }
}

export function useHistoryDocumentDialogState() {
  const [isDocumentDialogOpen, setIsDocumentDialogOpen] = useState(false)
  const [isDocumentLoading, setIsDocumentLoading] = useState(false)
  const [documentDetail, setDocumentDetail] = useState<DocumentDetails | null>(null)
  const [documentError, setDocumentError] = useState<string | null>(null)

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
      if (isNotFoundError(error)) {
        return 'unavailable'
      }

      return 'error'
    } finally {
      setIsDocumentLoading(false)
    }
  }, [])

  const handleDocumentDialogOpenChange = useCallback((open: boolean) => {
    setIsDocumentDialogOpen(open)
    if (!open) {
      setDocumentDetail(null)
      setDocumentError(null)
    }
  }, [])

  return {
    isDocumentDialogOpen,
    isDocumentLoading,
    documentDetail,
    documentError,
    handleOpenCitation,
    handleDocumentDialogOpenChange,
  }
}
