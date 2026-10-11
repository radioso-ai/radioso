'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useQueryClient } from '@tanstack/react-query'

import { ConversationDrawer } from './conversation-drawer'
import type { OperatorActionResult } from './operator-composer'
import { InboxEmptyState } from './inbox/inbox-empty-state'
import { InboxLensToggle } from './inbox/inbox-lens-toggle'
import { InboxQueue } from './inbox/inbox-queue'
import { InboxResponseView } from './inbox/inbox-response-view'
import { useInboxAgentOptions } from './inbox/use-inbox-agent-options'
import { useInboxRecentlyClosed } from './inbox/use-inbox-recently-closed'
import {
  CloseReviewPopover,
  type CloseReviewInput,
} from '@/components/dashboard/quality/close-review-popover'
import { DashboardPage } from '@/components/dashboard/shared/dashboard-page'
import type { SelectedHistoryItem } from '@/components/dashboard/history/history-list'
import { Button } from '@/components/ui/button'
import { LogoSpinner } from '@/components/ui/spinner'
import {
  getQualityTriageConflict,
  qualityApi,
  type QualityTriageRecord,
} from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { getHitlApiErrorStatus } from '@/lib/api-hitl'
import type { DeliveryFailure, HeldReply } from '@/lib/api-reply-review'
import { useOptionalAuth } from '@/lib/auth-context'
import { dashboardQueryKeys } from '@/lib/dashboard-query-keys'
import { buildDashboardHref, type DashboardRouteState } from '@/lib/dashboard-routes'
import { decideDefaultInboxLens, hasBlockingInboxLoadError } from '@/lib/inbox-default-lens'
import {
  needsAttentionRouteTargetForItem,
  needsAttentionRouteTargetForItemAction,
  needsAttentionRouteTargetKey,
  needsAttentionNotFoundNotice,
  preserveMatchingQueueItem,
  resolveNeedsAttentionRouteSelection,
  type NeedsAttentionRouteTarget,
} from '@/lib/needs-attention-route'
import { useInboxAttentionSignal } from '@/hooks/use-inbox-attention-signal'
import {
  buildInboxModel,
  countInboxItemsByType,
  EMPTY_INBOX_FILTERS,
  filterInboxItems,
  findRefreshedInboxItem,
  listInboxAgents,
  listTakenByOperators,
  RECENTLY_CLOSED_LIMIT,
  selectHumanOwnedConversations,
  type InboxFilters,
  type InboxItem,
  type RecentlyClosedInboxItem,
} from '@/lib/needs-attention'
import {
  createEmptyQualityInboxSnapshot,
  qualityInboxPresentation,
  removeQualityInboxTurn,
  updateQualityInboxTurn,
  type QualityInboxSnapshot,
} from '@/lib/needs-attention-quality'
import {
  NEEDS_ATTENTION_PAGE_SIZE,
  qualityLoadStateFromQueries,
  qualitySnapshotFromQueries,
  useConversationSources,
  useNeedsAttentionQueries,
  withoutAttentionItem,
  type AttentionChunks,
} from '@/lib/needs-attention-query-state'
import { patchQualityTriage } from '@/lib/quality-query-state'
import { useDashboardQueryInvalidation } from '@/components/providers/dashboard-query-provider'
import { isTerminalQualityTriageState } from '@/lib/quality-signals'

interface NeedsAttentionViewProps {
  accountId: string
  routeState: DashboardRouteState
}

/**
 * A teammate without the takeover permission, or a server without the route, gets 403 or 404 from a
 * reply-review source, and that settled answer is "none". Its polls must not count as loading: a
 * query with no data goes back to pending on every refetch, which would blank the Inbox each time.
 */
const isFirstReplyReviewLoad = (query: { isLoading: boolean; dataUpdatedAt: number; errorUpdatedAt: number }) =>
  query.isLoading && query.dataUpdatedAt === 0 && query.errorUpdatedAt === 0

export function NeedsAttentionView({ accountId, routeState }: NeedsAttentionViewProps) {
  const workspaceId = routeState.workspaceId ?? ''
  // "Taken by: me" is the signed-in teammate, not their organisation.
  const currentUserId = useOptionalAuth()?.user?.userId ?? null
  const attentionQueries = useNeedsAttentionQueries(workspaceId)
  const queryClient = useQueryClient()
  const router = useRouter()
  const hasAppliedDefaultLensRef = useRef(false)
  const invalidateDashboardQueries = useDashboardQueryInvalidation()
  const qualitySnapshotInputs = useMemo(() => ({
    commentedFeedback: {
      data: attentionQueries.commentedFeedback.data,
      error: attentionQueries.commentedFeedback.error,
      status: attentionQueries.commentedFeedback.status,
    },
    reviewSummary: {
      data: attentionQueries.reviewSummary.data,
      error: attentionQueries.reviewSummary.error,
      status: attentionQueries.reviewSummary.status,
    },
  }), [
    attentionQueries.commentedFeedback.data,
    attentionQueries.commentedFeedback.error,
    attentionQueries.commentedFeedback.status,
    attentionQueries.reviewSummary.data,
    attentionQueries.reviewSummary.error,
    attentionQueries.reviewSummary.status,
  ])

  const [qualitySnapshot, setQualitySnapshot] = useState<QualityInboxSnapshot>(createEmptyQualityInboxSnapshot)
  const [appliedQualitySnapshotInputs, setAppliedQualitySnapshotInputs] =
    useState<typeof qualitySnapshotInputs | null>(null)
  const [terminalQualityMessageIds, setTerminalQualityMessageIds] = useState<ReadonlySet<string>>(new Set())
  const [now, setNow] = useState(() => new Date())
  const [filters, setFilters] = useState<InboxFilters>(EMPTY_INBOX_FILTERS)
  const [selectedInboxItem, setSelectedInboxItem] = useState<InboxItem | null>(null)
  const [selectedRecentlyClosedItem, setSelectedRecentlyClosedItem] = useState<RecentlyClosedInboxItem | null>(null)
  const [debugConversationId, setDebugConversationId] = useState<string | null>(null)
  const [triagingMessageIds, setTriagingMessageIds] = useState<ReadonlySet<string>>(new Set())
  const [triageError, setTriageError] = useState<string | null>(null)
  const [closeReview, setCloseReview] = useState<{
    item: InboxItem
    state: 'resolved' | 'dismissed'
    conflict: QualityTriageRecord | null
    anchor: HTMLElement | null
  } | null>(null)
  const [statusAnnouncement, setStatusAnnouncement] = useState('')
  const [notFoundNotice, setNotFoundNotice] = useState<string | null>(null)
  const preservedNotFoundNoticeRouteKeyRef = useRef<string | null>(null)
  // A route reconciliation must never overwrite a selection the operator just
  // made while a previous render's effect was still queued.
  const selectionWriteRef = useRef(0)
  // `pendingClearRouteKeyRef` names the route key being cleared *from* - the
  // key still live when the clear was issued. The reconciliation effect
  // below waits only while `routeTargetKey` still equals it (the clear's own
  // push hasn't landed yet); once it differs - whether that's the expected
  // "nothing selected" or some other navigation that overtook it - the wait
  // ends and reconciliation runs normally against whatever is actually live.
  const pendingClearRouteKeyRef = useRef<string | null>(null)
  // The mirror image of `pendingClearRouteKeyRef`, for a select instead of a
  // clear: a click sets the local selection and `router.push`'s own URL
  // update synchronously, but the `routeState` prop this effect reads only
  // catches up once Next.js applies the navigation. Until then `routeTarget`
  // still reflects the *previous* selection, and without this guard the
  // reconciliation below reads that as the operator having cleared the row
  // and wipes the selection it was just handed - which also tears down and
  // restarts the response pane's conversation-detail and tail-poll hooks on
  // every single click (see hitl-needs-attention.spec.ts's tail-poll
  // ownership test). This stores the *from* key - the route key still live
  // at the moment of the click - not the destination: waiting only while
  // `routeTargetKey` still equals that stale from-key means any actual
  // navigation ends the wait, whether it lands on the click's own
  // destination, a back/forward that supersedes it, or a third target from
  // an unrelated deep link. Pinning the destination instead would wait
  // forever for a navigation that no longer arrives whenever something else
  // wins the race. `undefined` means inactive; `null` is itself a valid
  // from-key (the click's previous state was "nothing selected"), so it
  // must stay distinguishable from "no select pending".
  const pendingSelectFromRouteKeyRef = useRef<string | null | undefined>(undefined)
  const [selectionWrite, setSelectionWrite] = useState(0)
  const routeTarget = useMemo<NeedsAttentionRouteTarget | undefined>(() => routeState.historyItemId
    && (routeState.historyItemKind === 'chat' || routeState.historyItemKind === 'inbox')
    ? { itemKind: routeState.historyItemKind, itemId: routeState.historyItemId }
    : undefined, [routeState.historyItemId, routeState.historyItemKind])
  const routeTargetKey = needsAttentionRouteTargetKey(routeTarget)

  const patchLatestQuality = useCallback((messageId: string, triage: QualityTriageRecord, remove: boolean) => {
    patchQualityTriage(queryClient, attentionQueries.commentedFeedback.queryKey, messageId, triage, remove)
    patchQualityTriage(queryClient, attentionQueries.reviewSummary.queryKey, messageId, triage, remove)
    invalidateDashboardQueries(['quality.triage_changed'])
  }, [attentionQueries.commentedFeedback.queryKey, attentionQueries.reviewSummary.queryKey, invalidateDashboardQueries, queryClient])

  // The quality snapshot always tracks the live query results (no manual
  // "promote latest" gate) - list changes flow straight into the queue, per
  // FR-016; only the selected response view is protected from being yanked.
  useEffect(() => {
    let cancelled = false
    void Promise.resolve().then(() => {
      if (cancelled) return
      setQualitySnapshot((previous) =>
        qualitySnapshotFromQueries(previous, qualitySnapshotInputs.commentedFeedback, qualitySnapshotInputs.reviewSummary))
      setAppliedQualitySnapshotInputs(qualitySnapshotInputs)
    })
    return () => { cancelled = true }
  }, [qualitySnapshotInputs])

  useEffect(() => {
    const intervalId = window.setInterval(() => setNow(new Date()), 30_000)
    return () => window.clearInterval(intervalId)
  }, [])

  const decisions = useMemo(() => attentionQueries.decisions.data?.decisions ?? [], [attentionQueries.decisions.data])
  const humanOwnedConversations = useMemo(
    () => selectHumanOwnedConversations(attentionQueries.humanOwned.data?.conversations ?? []),
    [attentionQueries.humanOwned.data],
  )
  const deliveryFailures = useMemo(
    () => attentionQueries.deliveryFailures.data?.items ?? [],
    [attentionQueries.deliveryFailures.data],
  )
  const heldReplies = useMemo(
    () => attentionQueries.heldReplies.data?.items ?? [],
    [attentionQueries.heldReplies.data],
  )
  // A failed reply on a conversation no human holds — an automatic reply that bounced — still
  // needs its conversation's title and agent, so the agent filter finds it.
  const failureConversationIds = useMemo(() => {
    const loaded = new Set(humanOwnedConversations.map((conversation) => conversation.id))
    return [...new Set(deliveryFailures.map((failure) => failure.conversationId))].filter((id) => !loaded.has(id))
  }, [deliveryFailures, humanOwnedConversations])
  const failureConversations = useConversationSources(workspaceId, failureConversationIds)
  // Each source reads up to its page limit; past it, the queue says some work is not shown and
  // offers to read on.
  const { olderAttention } = attentionQueries
  const qualityPresentation = useMemo(() => qualityInboxPresentation(qualitySnapshot), [qualitySnapshot])
  const qualityLoadState = qualityLoadStateFromQueries(
    attentionQueries.commentedFeedback,
    attentionQueries.reviewSummary,
  )
  const qualityTurns = useMemo(
    () => qualityPresentation.turns.filter((turn) => !terminalQualityMessageIds.has(turn.assistantMessageId)),
    [qualityPresentation.turns, terminalQualityMessageIds],
  )
  const inboxModel = useMemo(
    () => buildInboxModel({
      decisions,
      conversations: humanOwnedConversations,
      qualityTurns,
      deliveryFailures,
      failureConversations,
      heldReplies,
    }),
    [decisions, humanOwnedConversations, qualityTurns, deliveryFailures, failureConversations, heldReplies],
  )
  const items = inboxModel.items
  const criticalOpenCount = useMemo(
    () => items.reduce((count, item) => count + (item.severity === 'critical' ? 1 : 0), 0),
    [items],
  )

  // Tab title reflects every open item; the chime is critical-only (handoffs,
  // approvals, delivery failures) - written feedback moves the count but stays quiet.
  useInboxAttentionSignal(items.length, criticalOpenCount)

  // Re-sync the selected item's live fields (waiting time, taken-by, and —
  // for an approval — whether it's still pending) as the queue refetches. See
  // `findRefreshedInboxItem` for the match rule per type. Never cleared just
  // because it briefly falls out of the list - only explicit Done/decision
  // actions clear it.
  useEffect(() => {
    void Promise.resolve().then(() => {
      setSelectedInboxItem((current) => {
        if (!current) {
          return current
        }
        const fresh = findRefreshedInboxItem(items, current)
        return fresh && fresh !== current ? fresh : current
      })
    })
  }, [items])

  const isLoading = attentionQueries.policy.queriesEnabled && (
    attentionQueries.decisions.isLoading
    || attentionQueries.humanOwned.isLoading
    || isFirstReplyReviewLoad(attentionQueries.deliveryFailures)
    || isFirstReplyReviewLoad(attentionQueries.heldReplies)
    || attentionQueries.commentedFeedback.isLoading
    || attentionQueries.reviewSummary.isLoading
  )
  const approvalError = attentionQueries.decisions.error
    ? getApiErrorMessage(attentionQueries.decisions.error, 'Failed to load pending approvals.')
    : null
  const conversationError = attentionQueries.humanOwned.error
    ? getApiErrorMessage(attentionQueries.humanOwned.error, 'Failed to load human-owned conversations.')
    : null
  // A teammate without the takeover permission, or a server without the route, has no failures to see.
  const deliveryFailureErrorStatus = getHitlApiErrorStatus(attentionQueries.deliveryFailures.error)
  const deliveryFailureError = attentionQueries.deliveryFailures.error
    && deliveryFailureErrorStatus !== 403
    && deliveryFailureErrorStatus !== 404
    ? getApiErrorMessage(attentionQueries.deliveryFailures.error, 'Failed to load delivery failures.')
    : null
  // The same holds for held replies.
  const heldReplyErrorStatus = getHitlApiErrorStatus(attentionQueries.heldReplies.error)
  const heldReplyError = attentionQueries.heldReplies.error
    && heldReplyErrorStatus !== 403
    && heldReplyErrorStatus !== 404
    ? getApiErrorMessage(attentionQueries.heldReplies.error, 'Failed to load draft replies.')
    : null

  const typeCounts = useMemo(() => countInboxItemsByType(items), [items])
  const workspaceAgentOptions = useInboxAgentOptions(Boolean(workspaceId))
  const queueAgentOptions = useMemo(() => listInboxAgents(items), [items])
  const agentOptions = workspaceAgentOptions.length > 0 ? workspaceAgentOptions : queueAgentOptions
  const operatorOptions = useMemo(() => listTakenByOperators(items, currentUserId), [items, currentUserId])
  const filteredItems = useMemo(
    () => filterInboxItems(items, filters, { currentUserId }),
    [items, filters, currentUserId],
  )

  const recentlyClosedQuery = useInboxRecentlyClosed(workspaceId)
  const recentlyClosed = recentlyClosedQuery.items
  const filteredRecentlyClosed = useMemo(() => {
    const query = filters.search.trim().toLowerCase()
    return query.length === 0
      ? recentlyClosed
      : recentlyClosed.filter((item) => item.title.toLowerCase().includes(query))
  }, [recentlyClosed, filters.search])
  const isSelectionDataReady = attentionQueries.policy.queriesEnabled
    && !isLoading
    && !recentlyClosedQuery.isLoading
    && !approvalError
    && !conversationError
    && !qualityLoadState.hasLoadFailure
    && !recentlyClosedQuery.hasLoadFailure
    // `items` reads the promoted snapshot, not the query result directly.
    // Wait for that promotion so a negative-feedback permalink cannot be
    // called missing during the microtask between query success and snapshot
    // application.
    && appliedQualitySnapshotInputs === qualitySnapshotInputs
  const routeSelection = useMemo(
    () => resolveNeedsAttentionRouteSelection({
      target: routeTarget,
      items,
      recentlyClosed,
      open: selectedInboxItem ?? selectedRecentlyClosedItem,
      isReady: isSelectionDataReady,
    }),
    [isSelectionDataReady, items, recentlyClosed, routeTarget, selectedInboxItem, selectedRecentlyClosedItem],
  )

  const beginSelectionWrite = useCallback(() => {
    const next = selectionWriteRef.current + 1
    selectionWriteRef.current = next
    setSelectionWrite(next)
  }, [])

  const clearSelectionRoute = useCallback((target: NeedsAttentionRouteTarget) => {
    // An operator can select another row while a prior action or detail fetch
    // is finishing. Only clear the route that action/fetch actually opened.
    const live = new URLSearchParams(window.location.search)
    if (live.get('itemKind') !== target.itemKind || live.get('itemId') !== target.itemId) {
      return
    }
    beginSelectionWrite()
    pendingClearRouteKeyRef.current = needsAttentionRouteTargetKey(target)
    pendingSelectFromRouteKeyRef.current = undefined
    setSelectedInboxItem(null)
    setSelectedRecentlyClosedItem(null)
    router.replace(buildDashboardHref(accountId, {
      ...routeState,
      section: 'activity',
      activityTab: 'needs-attention',
      historyItemKind: undefined,
      historyItemId: undefined,
      historyMessageId: undefined,
    }))
  }, [accountId, beginSelectionWrite, routeState, router])

  const clearItemSelectionRoute = useCallback((item: InboxItem | RecentlyClosedInboxItem) => {
    clearSelectionRoute(needsAttentionRouteTargetForItemAction(item, routeTarget))
  }, [clearSelectionRoute, routeTarget])

  /* eslint-disable react-hooks/set-state-in-effect -- This consumes the browser route into queue-local row data once the queues load. */
  useEffect(() => {
    const live = new URLSearchParams(window.location.search)
    const liveItemKind = live.get('itemKind')
    const liveItemId = live.get('itemId')
    const liveRouteKey = needsAttentionRouteTargetKey(
      liveItemId && (liveItemKind === 'chat' || liveItemKind === 'inbox')
        ? { itemKind: liveItemKind, itemId: liveItemId }
        : undefined,
    )
    if (liveRouteKey !== routeTargetKey || selectionWriteRef.current !== selectionWrite) {
      return
    }
    if (pendingClearRouteKeyRef.current !== null && pendingClearRouteKeyRef.current === routeTargetKey) {
      return
    }
    if (pendingClearRouteKeyRef.current !== null) {
      pendingClearRouteKeyRef.current = null
    }
    // The mirror check: a select just pushed away from this from-key, and
    // `routeTargetKey` hasn't moved off it yet (it still reflects the URL
    // from before the click). Treating that stale reflection as "nothing
    // selected" would undo the click itself, so wait for it to actually
    // change - to the click's destination or anything else - before
    // reconciling.
    if (pendingSelectFromRouteKeyRef.current !== undefined && pendingSelectFromRouteKeyRef.current === routeTargetKey) {
      return
    }
    if (pendingSelectFromRouteKeyRef.current !== undefined) {
      pendingSelectFromRouteKeyRef.current = undefined
    }
    // A detail fetch can 404 before `routeTargetKey` catches up to the row
    // it belongs to (the same gap the two guards above wait out) -
    // `handleReadingPaneItemNotFound` already knows that and records the
    // row's own key in `preservedNotFoundNoticeRouteKeyRef`, but its own
    // `clearSelectionRoute` call bails at the time, because the live URL
    // doesn't match that key yet either. Once this route finally does land,
    // reconciling it as a normal "item found" selection would silently
    // reselect a row already known to be dead and drop the notice with it.
    // Clear it now instead - the live URL matches it this time, so the
    // retry succeeds.
    if (routeTargetKey !== null && routeTargetKey === preservedNotFoundNoticeRouteKeyRef.current
      && (routeSelection.kind === 'item' || routeSelection.kind === 'recently-closed') && routeTarget) {
      clearSelectionRoute(routeTarget)
      return
    }

    if (routeSelection.kind === 'item') {
      preservedNotFoundNoticeRouteKeyRef.current = null
      setNotFoundNotice(needsAttentionNotFoundNotice(routeSelection))
      setSelectedInboxItem((current) => preserveMatchingQueueItem(current, routeSelection.item))
      setSelectedRecentlyClosedItem(null)
      return
    }
    if (routeSelection.kind === 'recently-closed') {
      preservedNotFoundNoticeRouteKeyRef.current = null
      setNotFoundNotice(needsAttentionNotFoundNotice(routeSelection))
      setSelectedInboxItem(null)
      setSelectedRecentlyClosedItem((current) => preserveMatchingQueueItem(current, routeSelection.item))
      return
    }
    if (routeSelection.kind === 'pending') {
      preservedNotFoundNoticeRouteKeyRef.current = null
      setNotFoundNotice(needsAttentionNotFoundNotice(routeSelection))
      setSelectedInboxItem(null)
      setSelectedRecentlyClosedItem(null)
      return
    }
    if (routeSelection.kind === 'missing' && routeTarget) {
      preservedNotFoundNoticeRouteKeyRef.current = routeTargetKey
      setNotFoundNotice(needsAttentionNotFoundNotice(routeSelection))
      clearSelectionRoute(routeTarget)
      return
    }
    if (!routeTarget && preservedNotFoundNoticeRouteKeyRef.current !== null) {
      setSelectedInboxItem(null)
      setSelectedRecentlyClosedItem(null)
      return
    }
    setNotFoundNotice(needsAttentionNotFoundNotice(routeSelection))
    setSelectedInboxItem(null)
    setSelectedRecentlyClosedItem(null)
  }, [clearSelectionRoute, routeSelection, routeTarget, routeTargetKey, selectionWrite])
  /* eslint-enable react-hooks/set-state-in-effect */

  const qualityReviewHref = useMemo(
    () => buildDashboardHref(accountId, {
      section: 'quality',
      workspaceId: routeState.workspaceId,
      workspacePublicRouteKey: routeState.workspacePublicRouteKey,
    }),
    [accountId, routeState],
  )
  const buildRoutineHref = useCallback(
    (agentId: string, routineId: string) =>
      buildDashboardHref(accountId, {
        ...routeState,
        section: 'agents',
        agentId,
        agentRoutineId: routineId,
        agentTab: undefined,
        anchor: undefined,
      }),
    [accountId, routeState],
  )

  // Acknowledging is a background nicety (marks a feedback item as being
  // looked at) - a failure here doesn't block the operator, so it's silent
  // beyond the terminal-conflict case, which still needs to drop a stale item.
  const handleAcknowledge = useCallback(async (item: InboxItem) => {
    const messageId = item.assistantMessageId
    if (!messageId || item.type !== 'negative_feedback' || item.triageState !== 'open') {
      return
    }
    try {
      const triage = await qualityApi.setTriageState(messageId, {
        state: 'acknowledged',
        expectedVersion: item.triage?.version ?? 0,
      })
      setQualitySnapshot((previous) =>
        updateQualityInboxTurn(previous, messageId, (turn) => ({ ...turn, triage })))
      patchLatestQuality(messageId, triage, false)
    } catch (caught) {
      const current = getQualityTriageConflict(caught)
      if (!current) {
        return
      }
      if (isTerminalQualityTriageState(current.state)) {
        setTerminalQualityMessageIds((previous) => new Set([...previous, messageId]))
        patchLatestQuality(messageId, current, true)
        // The row disappears from the queue via terminalQualityMessageIds
        // above; the response pane must drop the same item, or it keeps
        // offering Done/resolution actions for a feedback item another
        // operator already closed.
        clearItemSelectionRoute(item)
        setStatusAnnouncement('Another operator already closed this feedback. It was removed from the inbox.')
      } else {
        setQualitySnapshot((previous) =>
          updateQualityInboxTurn(previous, messageId, (turn) => ({ ...turn, triage: current })))
        patchLatestQuality(messageId, current, false)
      }
    }
  }, [clearItemSelectionRoute, patchLatestQuality])

  const handleSelectItem = useCallback((item: InboxItem) => {
    beginSelectionWrite()
    pendingClearRouteKeyRef.current = null
    pendingSelectFromRouteKeyRef.current = routeTargetKey
    preservedNotFoundNoticeRouteKeyRef.current = null
    setNotFoundNotice(null)
    setSelectedInboxItem(item)
    setSelectedRecentlyClosedItem(null)
    router.push(buildDashboardHref(accountId, {
      ...routeState,
      section: 'activity',
      activityTab: 'needs-attention',
      historyItemKind: 'inbox',
      historyItemId: needsAttentionRouteTargetForItem(item).itemId,
      historyMessageId: undefined,
    }))
    if (item.type === 'negative_feedback' && item.triageState === 'open') {
      void handleAcknowledge(item)
    }
  }, [accountId, beginSelectionWrite, handleAcknowledge, routeState, router, routeTargetKey])

  const handleSelectRecentlyClosed = useCallback((item: RecentlyClosedInboxItem) => {
    beginSelectionWrite()
    pendingClearRouteKeyRef.current = null
    pendingSelectFromRouteKeyRef.current = routeTargetKey
    preservedNotFoundNoticeRouteKeyRef.current = null
    setNotFoundNotice(null)
    setSelectedInboxItem(null)
    setSelectedRecentlyClosedItem(item)
    router.push(buildDashboardHref(accountId, {
      ...routeState,
      section: 'activity',
      activityTab: 'needs-attention',
      historyItemKind: 'inbox',
      historyItemId: needsAttentionRouteTargetForItem(item).itemId,
      historyMessageId: undefined,
    }))
  }, [accountId, beginSelectionWrite, routeState, router, routeTargetKey])

  const handleReadingPaneItemNotFound = useCallback(() => {
    const item = selectedInboxItem ?? selectedRecentlyClosedItem
    if (!item) {
      return
    }
    preservedNotFoundNoticeRouteKeyRef.current = needsAttentionRouteTargetKey(
      needsAttentionRouteTargetForItemAction(item, routeTarget),
    )
    setNotFoundNotice('This conversation is no longer available.')
    clearItemSelectionRoute(item)
  }, [clearItemSelectionRoute, routeTarget, selectedInboxItem, selectedRecentlyClosedItem])

  // A reply or takeover re-reads held replies through `conversation.ownership_changed`.
  const heldRepliesKey = useMemo(
    () => dashboardQueryKeys.attention.heldReplies(workspaceId, { limit: NEEDS_ATTENTION_PAGE_SIZE }),
    [workspaceId],
  )

  const handleOperatorChanged = useCallback(async (result: OperatorActionResult) => {
    if (result.kind === 'ownership') {
      invalidateDashboardQueries(['conversation.ownership_changed'])
      if (result.ownershipState === 'ai_owned') {
        // A hand-back just closed this handoff item - Done's single wrap-up
        // action, so clear the selection and let the operator pick the next one.
        if (selectedInboxItem?.conversationId === result.conversationId) {
          clearItemSelectionRoute(selectedInboxItem)
        }
      }
    } else if (result.kind === 'decision_resolved') {
      invalidateDashboardQueries(['hitl.decision_resolved'])
      // Only the selected approval can produce this result (decision buttons
      // render only for the item currently open in the response view).
      if (selectedInboxItem?.type === 'approval') {
        clearItemSelectionRoute(selectedInboxItem)
      }
    } else if (result.kind === 'refresh') {
      invalidateDashboardQueries(
        result.reason === 'conflict' ? ['conversation.ownership_changed'] : ['hitl.decision_resolved'],
      )
    } else if (result.kind === 'reply') {
      // A reply can implicitly claim the conversation (FR-009); invalidate
      // ownership so a teammate's queue reflects the claim without waiting on
      // the next poll cycle.
      invalidateDashboardQueries(['conversation.ownership_changed'])
    } else if (result.kind === 'held_reply_settled') {
      // A sent reply leaves the queue at once; a discarded one stays until someone replies. The
      // panel keeps the selection, its focus, and says what happened itself. The server's own
      // `hitl.decision_resolved` re-reads the rest; this view does not wait for it.
      if (result.outcome === 'released' || result.outcome === 'edited') {
        queryClient.setQueryData<AttentionChunks<HeldReply>>(heldRepliesKey, (chunks) =>
          withoutAttentionItem(chunks, result.heldReplyId))
      }
      invalidateDashboardQueries(['hitl.decision_resolved'])
    } else if (result.kind === 'delivery_failure_cleared') {
      // No workspace event reports a cleared failure, so this view drops the row itself and
      // re-reads the failures and the recently-closed strip.
      const deliveryFailuresKey = dashboardQueryKeys.attention.deliveryFailures(workspaceId, { limit: NEEDS_ATTENTION_PAGE_SIZE })
      queryClient.setQueryData<AttentionChunks<DeliveryFailure>>(deliveryFailuresKey, (chunks) =>
        withoutAttentionItem(chunks, result.failureId))
      void queryClient.invalidateQueries({ queryKey: deliveryFailuresKey })
      void queryClient.invalidateQueries({
        queryKey: dashboardQueryKeys.attention.recentlyClosed(workspaceId, { limit: RECENTLY_CLOSED_LIMIT }),
      })
      // An acknowledgement closes the item; a resolution keeps it open so its panel can say what
      // happened and keep focus (it announces that itself).
      if (result.resolution === 'acknowledged') {
        if (selectedInboxItem?.type === 'delivery_failed' && selectedInboxItem.deliveryFailure?.id === result.failureId) {
          clearItemSelectionRoute(selectedInboxItem)
        }
        setStatusAnnouncement('Delivery failure acknowledged.')
      }
    }
  }, [clearItemSelectionRoute, heldRepliesKey, invalidateDashboardQueries, queryClient, selectedInboxItem, workspaceId])

  const requestCloseReview = useCallback((item: InboxItem, anchor: HTMLElement) => {
    setTriageError(null)
    setCloseReview({ item, state: 'resolved', conflict: null, anchor })
  }, [])

  const handleTriage = useCallback(async (input: CloseReviewInput) => {
    const item = closeReview?.item
    const messageId = item?.assistantMessageId
    if (!item || !messageId) {
      return
    }
    const state = input.state
    setTriagingMessageIds((prev) => new Set(prev).add(messageId))
    setTriageError(null)

    try {
      const triage = await qualityApi.setTriageState(messageId, {
        state,
        expectedVersion: item.triage?.version ?? 0,
        ...(input.resolution ? { resolution: input.resolution } : {}),
      })
      setQualitySnapshot((previous) => removeQualityInboxTurn(previous, messageId))
      patchLatestQuality(messageId, triage, true)
      clearItemSelectionRoute(item)
      setCloseReview(null)
      setStatusAnnouncement(state === 'resolved' ? 'Marked resolved.' : 'Dismissed as not actionable.')
    } catch (caught) {
      const current = getQualityTriageConflict(caught)
      if (current) {
        const terminal = isTerminalQualityTriageState(current.state)
        if (terminal) {
          setTerminalQualityMessageIds((previous) => new Set([...previous, messageId]))
        }
        setQualitySnapshot((previous) => terminal
          ? removeQualityInboxTurn(previous, messageId)
          : updateQualityInboxTurn(previous, messageId, (turn) => ({ ...turn, triage: current })))
        patchLatestQuality(messageId, current, terminal)
        setCloseReview((pending) => pending?.item.assistantMessageId === messageId
          ? { ...pending, conflict: current, item: { ...pending.item, triageState: current.state, triage: current } }
          : pending)
        setStatusAnnouncement('Another operator changed this review. Their current decision is shown in the dialog.')
      } else {
        setTriageError(
          state === 'resolved'
            ? 'Could not mark this feedback as resolved. Try again.'
            : 'Could not dismiss this feedback. Try again.',
        )
      }
    } finally {
      setTriagingMessageIds((prev) => {
        const next = new Set(prev)
        next.delete(messageId)
        return next
      })
    }
  }, [clearItemSelectionRoute, closeReview, patchLatestQuality])

  const debugSelectedItem: SelectedHistoryItem = useMemo(
    () => debugConversationId ? { kind: 'chat', id: debugConversationId } : null,
    [debugConversationId],
  )
  // A queue with zero open items still renders the full two-pane shell (the
  // lens toggle lives in the left pane) — only the row list swaps for the
  // confidence message, so the operator can always reach the All lens even
  // when nothing needs them (spec 1116 unification, fix for issue #6).
  const isQueueEmpty = !isLoading && !approvalError && !conversationError && !deliveryFailureError && !heldReplyError
    && items.length === 0
  const showNoFilterMatches = !isQueueEmpty
    && filteredItems.length === 0
    && !selectedInboxItem
    && !selectedRecentlyClosedItem

  // Smart default lens (see lib/inbox-default-lens.ts for the decision rule
  // and its rationale): routeState.activityTab is undefined only when the
  // operator arrived with no explicit lens choice — an explicit
  // `?tab=needs-attention` (see buildActivityTabHref) always short-circuits
  // this effect entirely.
  //
  // The quality snapshot above promotes on a queued microtask (see that
  // effect's comment), so the render where `isLoading` first flips false can
  // still read a stale, too-small `items` — a queue that actually has an open
  // feedback item can render as transiently empty for one pass. Deciding on
  // that render would fire a real navigation from a reading that a moment
  // later turns out to be wrong, and `hasAppliedDefaultLensRef` intentionally
  // never reconsiders once decided. Debouncing behind a zero-delay timeout —
  // cancelled and rescheduled by the dependency array below whenever any
  // input changes — only lets the decision run once the inputs have gone a
  // full tick without changing, i.e. once they've actually settled.
  //
  // The blocking-error inputs come from `qualityLoadState`, read off the
  // queries rather than the snapshot: a promotion that lands after this
  // timeout would let an empty reading redirect past the very permission or
  // failure message the operator needs to see.
  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      const decision = decideDefaultInboxLens({
        activityTab: routeState.activityTab,
        alreadyDecided: hasAppliedDefaultLensRef.current,
        isLoading,
        hasError: hasBlockingInboxLoadError({
          approvalError: Boolean(approvalError),
          conversationError: Boolean(conversationError),
          qualityLoadFailed: qualityLoadState.hasLoadFailure,
          qualityPermissionDenied: qualityLoadState.permissionDenied,
        }),
        isQueueEmpty,
      })

      if (decision.kind === 'wait') {
        return
      }

      hasAppliedDefaultLensRef.current = true
      if (decision.kind === 'redirect') {
        router.replace(buildDashboardHref(accountId, { ...routeState, section: 'activity', activityTab: decision.activityTab }))
      }
    }, 0)

    return () => window.clearTimeout(timeoutId)
  }, [
    accountId,
    approvalError,
    conversationError,
    isLoading,
    isQueueEmpty,
    qualityLoadState.hasLoadFailure,
    qualityLoadState.permissionDenied,
    routeState,
    router,
  ])

  return (
    <>
      <DashboardPage title="Inbox" contentScroll={false} contentClassName="flex min-h-0 flex-1 flex-col p-0">
        <p className="sr-only" role="status" aria-live="polite">{statusAnnouncement}</p>
        {approvalError ? (
          <div className="m-3 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {approvalError}
          </div>
        ) : null}
        {conversationError ? (
          <div className="m-3 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {conversationError}
          </div>
        ) : null}
        {deliveryFailureError ? (
          <div className="m-3 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {deliveryFailureError}
          </div>
        ) : null}
        {heldReplyError ? (
          <div className="m-3 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {heldReplyError}
          </div>
        ) : null}
        {olderAttention.available ? (
          <div className="m-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
            <span>Older drafts or delivery failures are waiting beyond what the Inbox shows.</span>
            <Button type="button" size="sm" variant="outline" disabled={olderAttention.loading} onClick={olderAttention.load}>
              {olderAttention.loading ? 'Loading…' : 'Load older'}
            </Button>
          </div>
        ) : null}

        {isLoading ? (
          <div className="flex flex-1 items-center justify-center">
            <LogoSpinner imageClassName="h-7 w-7" />
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col md:flex-row">
            <InboxQueue
              lensToggle={
                <InboxLensToggle
                  accountId={accountId}
                  routeState={routeState}
                  activeTab="needs-attention"
                  needsYouCount={items.length}
                />
              }
              items={filteredItems}
              isQueueEmpty={isQueueEmpty}
              recentlyClosed={filteredRecentlyClosed}
              typeCounts={typeCounts}
              filters={filters}
              onFiltersChange={setFilters}
              agentOptions={agentOptions}
              operatorOptions={operatorOptions}
              now={now}
              selectedKey={selectedInboxItem?.key ?? null}
              selectedRecentlyClosedKey={selectedRecentlyClosedItem?.key ?? null}
              onSelect={handleSelectItem}
              onSelectRecentlyClosed={handleSelectRecentlyClosed}
            />
            {showNoFilterMatches ? (
              <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                No items match your filters.
              </div>
            ) : (
              <InboxResponseView
                workspaceId={workspaceId}
                selection={
                  selectedInboxItem
                    ? { source: 'item', item: selectedInboxItem }
                    : selectedRecentlyClosedItem
                      ? { source: 'readonly', conversationId: selectedRecentlyClosedItem.conversationId }
                      : null
                }
                now={now}
                pendingDecisions={decisions}
                onOperatorChanged={handleOperatorChanged}
                onRequestFeedbackClose={requestCloseReview}
                onOpenDebugView={setDebugConversationId}
                onItemNotFound={handleReadingPaneItemNotFound}
                emptyPlaceholder={notFoundNotice ?? (isQueueEmpty ? (
                  <InboxEmptyState
                    qualityReviewHref={qualityReviewHref}
                    untriagedQualityCount={qualityPresentation.reviewCount}
                    qualityPermissionDenied={qualityPresentation.permissionDenied}
                    qualityLoadFailed={qualityPresentation.hasLoadFailure}
                  />
                ) : undefined)}
              />
            )}
          </div>
        )}
      </DashboardPage>

      <ConversationDrawer
        selectedItem={debugSelectedItem}
        onSelectedItemChange={(next) => setDebugConversationId(next?.kind === 'chat' ? next.id : null)}
        onAfterClose={() => setDebugConversationId(null)}
        buildRoutineHref={buildRoutineHref}
      />

      {closeReview ? (
        <CloseReviewPopover
          key={`${closeReview.item.key}:${closeReview.state}`}
          open
          anchor={closeReview.anchor}
          state={closeReview.state}
          submitting={Boolean(
            closeReview.item.assistantMessageId
            && triagingMessageIds.has(closeReview.item.assistantMessageId),
          )}
          error={triageError}
          conflict={closeReview.conflict}
          onOpenChange={(open) => {
            if (!open) {
              setCloseReview(null)
              setTriageError(null)
            }
          }}
          onSubmit={handleTriage}
        />
      ) : null}
    </>
  )
}
