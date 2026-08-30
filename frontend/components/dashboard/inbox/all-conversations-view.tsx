'use client'

import { useEffect, useMemo, useRef, useState } from 'react'

import { ConversationDrawer } from '@/components/dashboard/conversation-drawer'
import type { HistoryListItem, SelectedHistoryItem } from '@/components/dashboard/history/history-list'
import { HISTORY_PAGE_SIZE, useHistoryListState } from '@/components/dashboard/history/use-chat-history-state'
import type { OperatorActionResult } from '@/components/dashboard/operator-composer'
import { DashboardPage } from '@/components/dashboard/shared/dashboard-page'
import { LogoSpinner } from '@/components/ui/spinner'
import { buildDashboardHref, type DashboardRouteState } from '@/lib/dashboard-routes'
import { editionController } from '@/lib/edition-controller'
import { useNeedsAttentionOpenCount } from '@/lib/needs-attention-query-state'
import { buildConversationSearchParams, EMPTY_CONVERSATION_FILTERS } from '@/lib/conversation-filters'
import { useDebouncedValue } from '@/hooks/use-debounced-value'
import { useDashboardQueryInvalidation } from '@/components/providers/dashboard-query-provider'
import {
  clearAudiencePulseEvidenceHandoff,
  consumeAudiencePulseEvidenceHandoff,
  type AudiencePulseEvidenceHandoff,
} from '@/lib/audience-pulse-evidence-handoff'
import {
  AllConversationsListPane,
  buildAgentOptions,
  buildSiteOptions,
  filterAllLensItems,
} from './all-conversations-list-pane'
import { InboxLensToggle } from './inbox-lens-toggle'
import { InboxResponseView, type InboxResponseSelection } from './inbox-response-view'

// Matches the "collapse rapid keystrokes into one request" convention documented on
// useDebouncedValue; 300ms is short enough to feel live, long enough that a fast typist
// doesn't fire a request per keystroke.
const SEARCH_DEBOUNCE_MS = 300

const formatPageSummary = ({
  currentPage,
  pageSize,
  pageItemCount,
  totalItems,
}: {
  currentPage: number
  pageSize: number
  pageItemCount: number
  totalItems: number
}) => {
  const pageStart = totalItems === 0 ? 0 : (currentPage - 1) * pageSize
  const pageEnd = Math.min(pageStart + pageItemCount, totalItems)
  return `${pageStart + 1} to ${pageEnd} of ${totalItems}`
}

/**
 * The "All" lens (spec 1116 unification) — the conversation log in the same
 * two-pane shell the Needs-you lens uses. Replaces the old dedicated
 * Conversations table page (`chat-history-view.tsx` / the `chat` branch of
 * `HistoryList`); search and contact history entries keep their existing,
 * unstyled row content and still open the debug drawer directly, since they
 * have no response-view equivalent — only chat rows get the new row style and
 * drive the reading pane.
 */
export function AllConversationsView({
  accountId,
  routeState,
}: {
  accountId: string
  routeState: DashboardRouteState
}) {
  const [conversationFilters, setConversationFilters] = useState(EMPTY_CONVERSATION_FILTERS)
  // Debounced so typing doesn't fire a request per keystroke; the input itself stays
  // responsive (conversationFilters.search updates immediately for the controlled Input).
  const debouncedSearch = useDebouncedValue(conversationFilters.search, SEARCH_DEBOUNCE_MS)
  // The All lens's server-side search/filter params (issue #1126) — sent to the merged
  // history endpoint instead of filtering the loaded page client-side. Only meaningful
  // for the 'all' variant; useHistoryListState ignores it for the other three.
  const serverSearchParams = useMemo(
    () => buildConversationSearchParams({ ...conversationFilters, search: debouncedSearch }),
    [conversationFilters, debouncedSearch],
  )

  const {
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
    onSelectItem,
    onConversationPageChange,
    onSearchPageChange,
    onContactPageChange,
    onAllPageChange,
  } = useHistoryListState({ accountId, routeState, serverSearchParams })

  const [debugConversationId, setDebugConversationId] = useState<string | null>(null)
  // Which of the drawer's two purposes triggered the close in progress —
  // read by onAfterClose, which fires after debugConversationId may already
  // have been cleared by onSelectedItemChange, so it can't re-derive the mode
  // from state at that point.
  const drawerModeRef = useRef<'debug' | 'primary'>('primary')
  const [now, setNow] = useState(() => new Date())
  const needsYouCount = useNeedsAttentionOpenCount(routeState.workspaceId ?? '')

  // The in_progress/completed outcome split is time-windowed (see
  // deriveConversationOutcome); refresh periodically so a row and the read-only
  // footer both age from "in progress" to "completed" without a page reload,
  // matching the Needs-you lens's own refresh cadence.
  useEffect(() => {
    const intervalId = window.setInterval(() => setNow(new Date()), 30_000)
    return () => window.clearInterval(intervalId)
  }, [])
  const invalidateDashboardQueries = useDashboardQueryInvalidation()

  // Audience Pulse evidence handoff (ported from the old chat-history-view.tsx):
  // a one-shot, out-of-URL selection consumed from sessionStorage that
  // auto-selects a conversation and anchors the reading pane to a specific
  // message, without ever putting the conversation/message id in a URL.
  const evidenceHandoffRef = useRef<{
    scope: string | null
    handoff: AudiencePulseEvidenceHandoff | null | undefined
    delivered: boolean
  }>({ scope: null, handoff: undefined, delivered: false })
  const [audiencePulseEvidence, setAudiencePulseEvidence] = useState<AudiencePulseEvidenceHandoff | null>(null)

  useEffect(() => {
    const workspaceId = routeState.workspaceId
    if (!workspaceId || (routeState.historyItemKind && routeState.historyItemId)) {
      clearAudiencePulseEvidenceHandoff()
      evidenceHandoffRef.current = {
        scope: workspaceId ? `${accountId}:${workspaceId}` : null,
        handoff: null,
        delivered: true,
      }
      // eslint-disable-next-line react-hooks/set-state-in-effect -- An explicit Activity URL must supersede a transient Audience Pulse selection.
      setAudiencePulseEvidence(null)
      return
    }

    const scope = `${accountId}:${workspaceId}`
    if (evidenceHandoffRef.current.scope !== scope) {
      evidenceHandoffRef.current = { scope, handoff: undefined, delivered: false }
    }
    if (evidenceHandoffRef.current.handoff === undefined) {
      evidenceHandoffRef.current.handoff = consumeAudiencePulseEvidenceHandoff({ accountId, workspaceId })
    }

    const handoff = evidenceHandoffRef.current.handoff
    if (!handoff) {
      setAudiencePulseEvidence(null)
      return
    }
    if (evidenceHandoffRef.current.delivered) {
      return
    }
    if (selectedItem?.kind === 'chat' && selectedItem.id === handoff.conversationId) {
      evidenceHandoffRef.current.delivered = true
      return
    }

    setAudiencePulseEvidence(handoff)
    setSelectedItem({ kind: 'chat', id: handoff.conversationId })
  }, [
    accountId,
    routeState.historyItemId,
    routeState.historyItemKind,
    routeState.workspaceId,
    selectedItem,
    setSelectedItem,
  ])

  const handleDrawerClosed = () => {
    setAudiencePulseEvidence(null)
    pushHistoryRoute({ selectedItem: null })
  }

  const handleSelectRow = (nextSelection: Parameters<typeof onSelectItem>[0]) => {
    setAudiencePulseEvidence(null)
    onSelectItem(nextSelection)
  }

  // A reply or Done acting in place on an actionable row changes conversation
  // ownership; invalidate so the row's outcome chip and the list catch up
  // instead of waiting for the next poll cycle.
  const handleOperatorChanged = (result: OperatorActionResult) => {
    if (result.kind === 'ownership' || result.kind === 'reply' || result.kind === 'refresh') {
      invalidateDashboardQueries(['conversation.ownership_changed'])
    }
  }

  const activeFilter = editionController.normalizeHistoryFilter(filter)

  const { items, pagination } = useMemo(() => {
    if (activeFilter === 'chat') {
      const chatItems: HistoryListItem[] = conversations.map((conversation) => ({
        kind: 'chat', id: conversation.id, sortAt: conversation.updatedAt, conversation,
      }))
      return {
        items: chatItems,
        pagination: {
          currentPage: conversationPage,
          totalPages: conversationTotalPages,
          totalItems: conversationTotal,
          onPrevious: () => onConversationPageChange(Math.max(1, conversationPage - 1)),
          onNext: () => onConversationPageChange(Math.min(conversationTotalPages, conversationPage + 1)),
          previousHref: buildDashboardHref(accountId, { ...routeState, section: 'activity', historyFilter: 'chat', historyPage: Math.max(1, conversationPage - 1) }),
          nextHref: buildDashboardHref(accountId, { ...routeState, section: 'activity', historyFilter: 'chat', historyPage: Math.min(conversationTotalPages, conversationPage + 1) }),
        },
      }
    }
    if (activeFilter === 'search') {
      const searchItems: HistoryListItem[] = searches.map((search) => ({
        kind: 'search', id: search.searchId, sortAt: search.createdAt, search,
      }))
      return {
        items: searchItems,
        pagination: {
          currentPage: searchPage,
          totalPages: searchTotalPages,
          totalItems: searchTotal,
          onPrevious: () => onSearchPageChange(Math.max(1, searchPage - 1)),
          onNext: () => onSearchPageChange(Math.min(searchTotalPages, searchPage + 1)),
          previousHref: buildDashboardHref(accountId, { ...routeState, section: 'activity', historyFilter: 'search', historyPage: Math.max(1, searchPage - 1) }),
          nextHref: buildDashboardHref(accountId, { ...routeState, section: 'activity', historyFilter: 'search', historyPage: Math.min(searchTotalPages, searchPage + 1) }),
        },
      }
    }
    if (activeFilter === 'contact') {
      const contactItems: HistoryListItem[] = contacts.map((contact) => ({
        kind: 'contact', id: contact.id, sortAt: contact.sortAt, contact,
      }))
      return {
        items: contactItems,
        pagination: {
          currentPage: contactPage,
          totalPages: contactTotalPages,
          totalItems: contactTotal,
          onPrevious: () => onContactPageChange(Math.max(1, contactPage - 1)),
          onNext: () => onContactPageChange(Math.min(contactTotalPages, contactPage + 1)),
          previousHref: buildDashboardHref(accountId, { ...routeState, section: 'activity', historyFilter: 'contact', historyPage: Math.max(1, contactPage - 1) }),
          nextHref: buildDashboardHref(accountId, { ...routeState, section: 'activity', historyFilter: 'contact', historyPage: Math.min(contactTotalPages, contactPage + 1) }),
        },
      }
    }
    const visibleAllItems = editionController.filterActivityItems(allHistoryItems)
    return {
      items: visibleAllItems,
      pagination: {
        currentPage: allPage,
        totalPages: allTotalPages,
        totalItems: allTotal,
        onPrevious: () => onAllPageChange(Math.max(1, allPage - 1)),
        onNext: () => onAllPageChange(Math.min(allTotalPages, allPage + 1)),
        previousHref: buildDashboardHref(accountId, { ...routeState, section: 'activity', historyFilter: 'all', historyPage: Math.max(1, allPage - 1) }),
        nextHref: buildDashboardHref(accountId, { ...routeState, section: 'activity', historyFilter: 'all', historyPage: Math.min(allTotalPages, allPage + 1) }),
      },
    }
  }, [
    accountId, activeFilter, allHistoryItems, allPage, allTotal, allTotalPages, contactPage, contactTotal,
    contactTotalPages, contacts, conversationPage, conversationTotal, conversationTotalPages, conversations,
    onAllPageChange, onContactPageChange, onConversationPageChange, onSearchPageChange, routeState, searchPage,
    searchTotal, searchTotalPages, searches,
  ])

  // The 'all' variant's search/outcome/agent/site filtering happens server-side (issue
  // #1126) — `items` is already the filtered page, so it passes through unchanged. The
  // other three variants (still reachable via deep links, e.g. Usage Details' "view
  // conversation" link into the chat-only variant) keep the pre-existing client-side
  // filter, since their backends were not extended to accept these params.
  const filteredItems = useMemo(
    () => (activeFilter === 'all' ? items : filterAllLensItems(items, conversationFilters, now)),
    [activeFilter, items, conversationFilters, now],
  )

  // Built from the unfiltered loaded page, not filteredItems — otherwise an
  // active filter or search narrows the dropdowns themselves, hiding other
  // agents/sites (including the one behind the operator's own active
  // selection) instead of just narrowing the rows.
  const unfilteredChatConversations = useMemo(
    () => items.flatMap((entry) => (entry.kind === 'chat' ? [entry.conversation] : [])),
    [items],
  )
  const agentOptions = useMemo(() => buildAgentOptions(unfilteredChatConversations), [unfilteredChatConversations])
  const siteOptions = useMemo(() => buildSiteOptions(unfilteredChatConversations), [unfilteredChatConversations])

  // A chat selection always resolves — the response view loads the
  // conversation independently by id (same as the old history drawer), so a
  // deep link works even when the row isn't on the currently loaded page. The
  // row's own summary is passed only as a best-effort hint: when present it
  // lets the header and actionable/read-only split render immediately instead
  // of waiting on the detail fetch.
  const selectedConversation = selectedItem?.kind === 'chat'
    ? items.find((entry): entry is Extract<HistoryListItem, { kind: 'chat' }> =>
      entry.kind === 'chat' && entry.id === selectedItem.id)?.conversation ?? null
    : null
  const isAudiencePulseEvidenceSelection = Boolean(
    audiencePulseEvidence && selectedItem?.kind === 'chat' && audiencePulseEvidence.conversationId === selectedItem.id,
  )
  // Audience Pulse evidence is a "jump to the debug drawer for this specific
  // historical exchange" analyst action, not an operator-reply moment — it
  // opens the builder drawer directly (matching the pre-1116 behavior), not
  // the reading pane. The reading pane deliberately stays empty for this
  // selection so it doesn't duplicate-fetch the same conversation the drawer
  // is already loading with its bounded evidence window.
  const responseSelection: InboxResponseSelection | null = selectedItem?.kind === 'chat' && !isAudiencePulseEvidenceSelection
    ? { source: 'readonly', conversationId: selectedItem.id, conversation: selectedConversation ?? undefined }
    : null
  const anchorMessageId = isAudiencePulseEvidenceSelection
    ? (audiencePulseEvidence?.messageId ?? null)
    : (routeState.historyMessageId ?? null)

  const drawerSelectedItem: SelectedHistoryItem = useMemo(
    () => debugConversationId
      ? { kind: 'chat', id: debugConversationId }
      : isAudiencePulseEvidenceSelection && selectedItem?.kind === 'chat'
        ? selectedItem
        : (selectedItem && selectedItem.kind !== 'chat' ? selectedItem : null),
    [debugConversationId, isAudiencePulseEvidenceSelection, selectedItem],
  )

  const buildRoutineHref = (agentId: string, routineId: string) =>
    buildDashboardHref(accountId, {
      ...routeState,
      section: 'agents',
      agentId,
      agentRoutineId: routineId,
      agentTab: undefined,
      anchor: undefined,
    })

  const lensToggle = (
    <InboxLensToggle accountId={accountId} routeState={routeState} activeTab="all" needsYouCount={needsYouCount} />
  )

  return (
    <>
      <DashboardPage title="Inbox" contentScroll={false} contentClassName="flex min-h-0 flex-1 flex-col p-0">
        {listError ? (
          <div className="m-3 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {listError}
          </div>
        ) : null}
        {isListLoading && !hasAnyHistory ? (
          <div className="flex flex-1 items-center justify-center">
            <LogoSpinner imageClassName="h-7 w-7" />
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col md:flex-row">
            <AllConversationsListPane
              lensToggle={lensToggle}
              items={filteredItems}
              agentOptions={agentOptions}
              siteOptions={siteOptions}
              filters={conversationFilters}
              onFiltersChange={setConversationFilters}
              now={now}
              selectedItem={selectedItem}
              onSelect={handleSelectRow}
              pagination={{
                summary: formatPageSummary({
                  currentPage: pagination.currentPage,
                  pageSize: HISTORY_PAGE_SIZE,
                  pageItemCount: isListLoading ? HISTORY_PAGE_SIZE : items.length,
                  totalItems: pagination.totalItems,
                }),
                currentPage: pagination.currentPage,
                totalPages: pagination.totalPages,
                previousHref: pagination.previousHref,
                nextHref: pagination.nextHref,
                onPrevious: pagination.onPrevious,
                onNext: pagination.onNext,
              }}
            />
            <InboxResponseView
              selection={responseSelection}
              now={now}
              pendingDecisions={[]}
              onOperatorChanged={handleOperatorChanged}
              onRequestFeedbackClose={() => {}}
              onOpenDebugView={setDebugConversationId}
              anchorMessageId={anchorMessageId}
              isAudiencePulseEvidence={isAudiencePulseEvidenceSelection}
            />
          </div>
        )}
      </DashboardPage>

      <ConversationDrawer
        selectedItem={drawerSelectedItem}
        anchorMessageId={isAudiencePulseEvidenceSelection ? anchorMessageId : undefined}
        isAudiencePulseEvidence={isAudiencePulseEvidenceSelection}
        onSelectedItemChange={(next) => {
          if (debugConversationId) {
            drawerModeRef.current = 'debug'
            setDebugConversationId(next?.kind === 'chat' ? next.id : null)
            return
          }
          // Raw local-state update on close (no URL push here) — mirrors the
          // old chat-history-view.tsx: pushing the URL happens once, in
          // onAfterClose, so it doesn't race the close animation.
          drawerModeRef.current = 'primary'
          setSelectedItem(next)
        }}
        onAfterClose={() => {
          if (drawerModeRef.current === 'debug') {
            setDebugConversationId(null)
            return
          }
          handleDrawerClosed()
        }}
        buildRoutineHref={buildRoutineHref}
      />
    </>
  )
}
