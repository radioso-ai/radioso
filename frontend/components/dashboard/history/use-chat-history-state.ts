'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

import {
  chatApi,
  documentsApi,
  type ChatConversationDetail,
  type ChatConversationMessage,
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
import {
  audiencePulseApi,
  type AudiencePulseEvidenceAnchorResponse,
} from '@/lib/api-audience-pulse'
import { getPrimaryLeaf } from '@/lib/turn-trace'
import { buildDashboardHref, type DashboardRouteState } from '@/lib/dashboard-routes'
import { editionController } from '@/lib/edition-controller'
import { mergeTailMessages } from '@/lib/conversation-tail'
import { useWorkspaceEventsOptional } from '@/lib/workspace-events-context'
import type { CitationOpenResult } from '@/components/dashboard/chat-citations'
import type { HistoryFilter, HistoryListItem, SelectedHistoryItem } from './history-list'

export const HISTORY_PAGE_SIZE = 50
export const MESSAGE_WINDOW_SIZE = 50
export const HISTORY_RECONCILE_INTERVAL_MS = 60_000

const HISTORY_CHANGE_KINDS = [
  'conversation.created',
  'conversation.updated',
  'conversation.contact_delivery_changed',
  'search.created',
] as const

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
  const [filter, setFilter] = useState<HistoryFilter>(editionController.normalizeHistoryFilter(routeState.historyFilter ?? 'all'))
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
    editionController.normalizeHistorySelection(
      routeState.historyItemKind && routeState.historyItemId
        ? { kind: routeState.historyItemKind, id: routeState.historyItemId }
        : null,
    ),
  )
  const [isListLoading, setIsListLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)
  const [loadedHistoryKey, setLoadedHistoryKey] = useState<string | null>(null)

  useEffect(() => {
    const nextFilter = editionController.normalizeHistoryFilter(routeState.historyFilter ?? 'all')
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
      setSelectedItem(editionController.normalizeHistorySelection({ kind: routeState.historyItemKind, id: routeState.historyItemId }))
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
    const nextFilter = editionController.normalizeHistoryFilter(next.filter ?? filter)
    const nextPage = next.page ?? (
      nextFilter === 'all'
        ? allPage
        : nextFilter === 'chat'
          ? conversationPage
          : nextFilter === 'search'
            ? searchPage
            : contactPage
    )
    const nextSelectedItem = editionController.normalizeHistorySelection(
      next.selectedItem === undefined ? selectedItem : next.selectedItem,
    )

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

  useWorkspaceEventsOptional(HISTORY_CHANGE_KINDS, loadHistory)

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- History view fetches the current page after route/filter changes.
    void loadHistory()
  }, [loadHistory, accountId, routeState.workspaceId])

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      void loadHistory()
    }, HISTORY_RECONCILE_INTERVAL_MS)

    return () => window.clearInterval(intervalId)
  }, [loadHistory])

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
      const enabledFilter = editionController.normalizeHistoryFilter(nextFilter)
      setFilter(enabledFilter)
      if (enabledFilter === 'all') setAllPage(1)
      if (enabledFilter === 'chat') setConversationPage(1)
      if (enabledFilter === 'search') setSearchPage(1)
      if (enabledFilter === 'contact') setContactPage(1)
      pushHistoryRoute({ filter: enabledFilter, page: 1, selectedItem: null })
    },
    onSelectItem: (item: SelectedHistoryItem) => {
      const enabledItem = editionController.normalizeHistorySelection(item)
      setSelectedItem(enabledItem)
      pushHistoryRoute({ selectedItem: enabledItem })
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

const withAudiencePulseEvidenceWindow = (
  detail: ChatConversationDetail,
  anchor: AudiencePulseEvidenceAnchorResponse,
): ChatConversationDetail => {
  const contextMessages = anchor.nextAssistant ? [anchor.source, anchor.nextAssistant] : [anchor.source]
  const messages: ChatConversationTurn[] = contextMessages.map((message) => ({
    id: message.messageId,
    role: message.role,
    source: message.source,
    content: message.content,
    createdAt: message.createdAt,
  }))

  return {
    ...detail,
    messageWindowOffset: 0,
    messageWindowLimit: Math.max(messages.length, 1),
    hasOlderMessages: false,
    nextCursor: null,
    messages,
  }
}

/**
 * Audience Pulse evidence is loaded through one bounded, dashboard-authorized
 * server window. A normal history read supplies conversation metadata, while
 * the anchor endpoint supplies only the source and its immediate answer context.
 */
const loadConversationDetail = async ({
  conversationId,
  anchorMessageId,
  isAudiencePulseEvidence,
  isActive,
}: {
  conversationId: string
  anchorMessageId?: string | null
  isAudiencePulseEvidence: boolean
  isActive: () => boolean
}): Promise<ChatConversationDetail | null> => {
  const detailRequest = chatApi.getHistoryConversation(conversationId, {
    limit: MESSAGE_WINDOW_SIZE,
  })
  if (!anchorMessageId || !isAudiencePulseEvidence) {
    const detail = await detailRequest
    return isActive() ? detail : null
  }

  const [detail, anchor] = await Promise.all([
    detailRequest,
    audiencePulseApi.getEvidenceAnchor({ conversationId, messageId: anchorMessageId }),
  ])
  if (!isActive()) return null
  return withAudiencePulseEvidenceWindow(detail, anchor)
}

export function useHistoryDetailState({
  selectedItem,
  setSelectedItem,
  onItemNotFound,
  anchorMessageId,
  isAudiencePulseEvidence = false,
  additionalConversationMessages = [],
}: {
  selectedItem: SelectedHistoryItem
  setSelectedItem: (item: SelectedHistoryItem) => void
  onItemNotFound?: () => void
  anchorMessageId?: string | null
  isAudiencePulseEvidence?: boolean
  additionalConversationMessages?: ChatConversationMessage[]
}) {
  const [conversationDetail, setConversationDetail] = useState<ChatConversationDetail | null>(null)
  const [searchDetail, setSearchDetail] = useState<DocumentSearchResponse | null>(null)
  const [contactDetail, setContactDetail] = useState<ContactHistoryDetailResponse | null>(null)
  const [isDetailLoading, setIsDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [selectedThreadMessageId, setSelectedThreadMessageId] = useState<string | null>(null)
  const [selectedAssistantMessageId, setSelectedAssistantMessageId] = useState<string | null>(null)
  const [selectedStageId, setSelectedStageId] = useState<string | undefined>(undefined)
  const [selectedSpineStageId, setSelectedSpineStageId] = useState<string | undefined>(undefined)
  const [showGraph, setShowGraph] = useState(false)
  const detailRequestIdRef = useRef(0)

  const loadDetail = useCallback(async () => {
    const requestId = detailRequestIdRef.current + 1
    detailRequestIdRef.current = requestId
    const isActive = () => detailRequestIdRef.current === requestId

    if (!selectedItem) {
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

    setIsDetailLoading(true)
    setDetailError(null)
    setConversationDetail(null)
    setSearchDetail(null)
    setContactDetail(null)

    try {
      if (selectedItem.kind === 'chat') {
        const detail = await loadConversationDetail({
          conversationId: selectedItem.id,
          anchorMessageId,
          isAudiencePulseEvidence,
          isActive,
        })
        if (!detail || !isActive()) {
          return
        }
        setConversationDetail(detail)
        const anchoredMessage = anchorMessageId
          ? detail.messages.find((message) => message.id === anchorMessageId) ?? null
          : null
        const anchoredMessageIndex = anchoredMessage
          ? detail.messages.findIndex((message) => message.id === anchoredMessage.id)
          : -1
        const assistantAfterAnchoredMessage = anchoredMessageIndex >= 0
          ? detail.messages.slice(anchoredMessageIndex + 1).find((message) => message.role === 'assistant') ?? null
          : null
        // Prefer the most recent assistant turn that recorded diagnostics, but
        // fall back to the latest assistant turn even when none did. Otherwise the
        // Debug panel opens to "select a message" for turns without a trace
        // (suspended/action-required, human-handled), making the button look dead.
        const reversedMessages = [...detail.messages].reverse()
        const traceBearingMessage =
          (anchoredMessage?.role === 'assistant' ? anchoredMessage : assistantAfterAnchoredMessage) ??
          reversedMessages.find((message) => message.role === 'assistant' && message.debug) ??
          reversedMessages.find((message) => message.role === 'assistant') ??
          null
        // Audience Pulse evidence points at the visitor question, not at its
        // following answer. Keep that exact question selected so the drawer
        // scrolls to the evidence while diagnostics continue to use its answer.
        setSelectedThreadMessageId(anchoredMessage?.id ?? traceBearingMessage?.id ?? null)
        setSelectedAssistantMessageId(traceBearingMessage?.id ?? null)
        const trace = traceBearingMessage?.debug?.activityTrace
        setSelectedStageId(trace?.stages[0]?.stageId)
        setShowGraph(false)
        return
      }

      if (selectedItem.kind === 'contact') {
        const detail = await chatApi.getContactHistory(selectedItem.id, {
          limit: MESSAGE_WINDOW_SIZE,
        })
        if (!isActive()) {
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
        const trace = detail.contact.activityTrace ?? (selectedAssistant?.role === 'assistant' ? selectedAssistant.debug?.activityTrace : undefined)
        setSelectedStageId(trace?.stages[0]?.stageId)
        setShowGraph(false)
        return
      }

      const detail = await chatApi.getSearchHistory(selectedItem.id)
      if (!isActive()) {
        return
      }
      setSearchDetail(detail)
      setSelectedStageId(detail.activityTrace?.stages[0]?.stageId)
      setShowGraph(false)
    } catch (error) {
      if (!isActive()) {
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
        onItemNotFound?.()
      }
    } finally {
      if (isActive()) {
        setIsDetailLoading(false)
      }
    }
  }, [anchorMessageId, isAudiencePulseEvidence, onItemNotFound, selectedItem, setSelectedItem])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Detail view fetches the current drawer item after selection changes.
    void loadDetail()
    return () => {
      detailRequestIdRef.current += 1
    }
  }, [loadDetail])

  const refetchDetail = useCallback(() => loadDetail(), [loadDetail])

  const effectiveConversationMessages = useMemo<ChatConversationTurn[]>(
    () =>
      conversationDetail
        ? (mergeTailMessages(conversationDetail.messages, additionalConversationMessages) as ChatConversationTurn[])
        : [],
    [additionalConversationMessages, conversationDetail],
  )

  const assistantMessages = useMemo(
    () => effectiveConversationMessages.filter((message) => message.role === 'assistant'),
    [effectiveConversationMessages],
  )

  const selectedThreadMessage = useMemo(
    () => effectiveConversationMessages.find((message) => message.id === selectedThreadMessageId) ?? null,
    [effectiveConversationMessages, selectedThreadMessageId],
  )

  const selectedAssistantMessage = useMemo(
    () =>
      assistantMessages.find((message) => message.id === selectedAssistantMessageId) ??
      assistantMessages[assistantMessages.length - 1] ??
      null,
    [assistantMessages, selectedAssistantMessageId],
  )

  const selectedDiagnosticsAssistantMessage = useMemo(() => {
    if (!selectedThreadMessage) {
      return selectedAssistantMessage
    }

    if (selectedThreadMessage.role === 'assistant') {
      return selectedThreadMessage
    }

    const messageIndex = effectiveConversationMessages.findIndex((message) => message.id === selectedThreadMessage.id)
    if (messageIndex < 0) {
      return null
    }

    return (
      effectiveConversationMessages
        .slice(messageIndex + 1)
        .find((message) => message.role === 'assistant') ?? null
    )
  }, [effectiveConversationMessages, selectedThreadMessage, selectedAssistantMessage])

  const selectedDiagnosticsDebug =
    selectedDiagnosticsAssistantMessage?.role === 'assistant' ? selectedDiagnosticsAssistantMessage.debug : undefined
  const contactTrace = contactDetail?.contact.activityTrace

  // Search is retrieval-only and has no conversation spine. Chat/contact turns
  // carry the turn-trace envelope (spine + capability leaves); prefer it, and
  // derive the legacy `activeTrace` from its primary retrieval leaf so the
  // outcome/run-parameter presenters keep working off the spine.
  const activeEnvelope = selectedItem?.kind === 'search' ? undefined : selectedDiagnosticsDebug?.turnTrace
  const envelopePrimaryLeaf = activeEnvelope ? getPrimaryLeaf(activeEnvelope.spine) : undefined
  const envelopePrimaryTrace = envelopePrimaryLeaf?.trace
  const selectedDiagnosticsTrace = envelopePrimaryTrace ?? selectedDiagnosticsDebug?.activityTrace
  const activeTrace = selectedItem?.kind === 'search'
    ? searchDetail?.activityTrace
    : selectedItem?.kind === 'contact'
      ? selectedDiagnosticsTrace ?? contactTrace
      : selectedDiagnosticsTrace
  const activeTraceId = activeTrace?.traceId
  const activeInitialStageId = activeTrace?.stages[0]?.stageId
  const activeSummary = selectedItem?.kind === 'contact'
    ? contactDetail?.contact.activitySummary ?? selectedDiagnosticsDebug?.activitySummary
    : selectedDiagnosticsDebug?.activitySummary

  // The spine stage selected by default: the dispatch stage that ran the primary
  // capability (so the rich retrieval leaf is front-and-center), else the first.
  const activeEnvelopeId = activeEnvelope?.spine.traceId
  const initialSpineStageId = envelopePrimaryLeaf?.stageId ?? activeEnvelope?.spine.stages[0]?.id

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Active trace changes reset the selected diagnostics stage.
    setSelectedStageId(activeInitialStageId)
  }, [activeTraceId, activeInitialStageId])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Switching turns resets the selected spine stage.
    setSelectedSpineStageId(initialSpineStageId)
  }, [activeEnvelopeId, initialSpineStageId])

  const handleSelectThreadMessage = useCallback(
    (messageId: string) => {
      if (!conversationDetail) {
        return
      }

      const messageIndex = effectiveConversationMessages.findIndex((message) => message.id === messageId)
      if (messageIndex < 0) {
        return
      }

      const clickedMessage = effectiveConversationMessages[messageIndex]
      setSelectedThreadMessageId(clickedMessage.id)

      const targetAssistant =
        clickedMessage.role === 'assistant'
          ? clickedMessage
          : effectiveConversationMessages
              .slice(messageIndex + 1)
              .find((message) => message.role === 'assistant')

      if (!targetAssistant || targetAssistant.role !== 'assistant') {
        return
      }

      setSelectedAssistantMessageId(targetAssistant.id)
      setSelectedStageId(targetAssistant.debug?.activityTrace?.stages[0]?.stageId)
    },
    [conversationDetail, effectiveConversationMessages],
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
    effectiveConversationMessages,
    searchDetail,
    contactDetail,
    isDetailLoading,
    detailError,
    selectedThreadMessage,
    selectedThreadMessageId,
    selectedDiagnosticsAssistantMessage: selectedDiagnosticsAssistantMessage as ChatConversationTurn | null,
    selectedDiagnosticsTrace,
    activeTrace,
    activeEnvelope,
    activeSummary,
    activeInitialStageId,
    selectedStageId,
    setSelectedStageId,
    selectedSpineStageId,
    setSelectedSpineStageId,
    showGraph,
    setShowGraph,
    refetchDetail,
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
