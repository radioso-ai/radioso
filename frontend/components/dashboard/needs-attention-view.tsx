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
import { LogoSpinner } from '@/components/ui/spinner'
import {
  getQualityTriageConflict,
  qualityApi,
  type QualityTriageRecord,
} from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { buildDashboardHref, type DashboardRouteState } from '@/lib/dashboard-routes'
import { decideDefaultInboxLens, hasBlockingInboxLoadError } from '@/lib/inbox-default-lens'
import { useInboxAttentionSignal } from '@/hooks/use-inbox-attention-signal'
import {
  buildInboxModel,
  countInboxItemsByType,
  EMPTY_INBOX_FILTERS,
  filterInboxItems,
  findRefreshedInboxItem,
  listInboxAgents,
  listTakenByOperators,
  selectHumanOwnedConversations,
  type InboxFilters,
  type InboxItem,
} from '@/lib/needs-attention'
import {
  createEmptyQualityInboxSnapshot,
  qualityInboxPresentation,
  removeQualityInboxTurn,
  updateQualityInboxTurn,
  type QualityInboxSnapshot,
} from '@/lib/needs-attention-quality'
import { qualitySnapshotFromQueries, useNeedsAttentionQueries } from '@/lib/needs-attention-query-state'
import { patchQualityTriage } from '@/lib/quality-query-state'
import { useDashboardQueryInvalidation } from '@/components/providers/dashboard-query-provider'
import { isTerminalQualityTriageState } from '@/lib/quality-signals'

interface NeedsAttentionViewProps {
  accountId: string
  routeState: DashboardRouteState
}

export function NeedsAttentionView({ accountId, routeState }: NeedsAttentionViewProps) {
  const workspaceId = routeState.workspaceId ?? ''
  const attentionQueries = useNeedsAttentionQueries(workspaceId)
  const queryClient = useQueryClient()
  const router = useRouter()
  const hasAppliedDefaultLensRef = useRef(false)
  const invalidateDashboardQueries = useDashboardQueryInvalidation()

  const [qualitySnapshot, setQualitySnapshot] = useState<QualityInboxSnapshot>(createEmptyQualityInboxSnapshot)
  const [terminalQualityMessageIds, setTerminalQualityMessageIds] = useState<ReadonlySet<string>>(new Set())
  const [now, setNow] = useState(() => new Date())
  const [filters, setFilters] = useState<InboxFilters>(EMPTY_INBOX_FILTERS)
  const [selectedInboxItem, setSelectedInboxItem] = useState<InboxItem | null>(null)
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

  const patchLatestQuality = useCallback((messageId: string, triage: QualityTriageRecord, remove: boolean) => {
    patchQualityTriage(queryClient, attentionQueries.commentedFeedback.queryKey, messageId, triage, remove)
    patchQualityTriage(queryClient, attentionQueries.reviewSummary.queryKey, messageId, triage, remove)
    invalidateDashboardQueries(['quality.triage_changed'])
  }, [attentionQueries.commentedFeedback.queryKey, attentionQueries.reviewSummary.queryKey, invalidateDashboardQueries, queryClient])

  // The quality snapshot always tracks the live query results (no manual
  // "promote latest" gate) - list changes flow straight into the queue, per
  // FR-016; only the selected response view is protected from being yanked.
  useEffect(() => {
    void Promise.resolve().then(() => {
      setQualitySnapshot((previous) =>
        qualitySnapshotFromQueries(previous, attentionQueries.commentedFeedback, attentionQueries.reviewSummary))
    })
    // Query status/data/error changes are the source of truth here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    attentionQueries.commentedFeedback.data,
    attentionQueries.commentedFeedback.error,
    attentionQueries.commentedFeedback.status,
    attentionQueries.reviewSummary.data,
    attentionQueries.reviewSummary.error,
    attentionQueries.reviewSummary.status,
  ])

  useEffect(() => {
    const intervalId = window.setInterval(() => setNow(new Date()), 30_000)
    return () => window.clearInterval(intervalId)
  }, [])

  const decisions = useMemo(() => attentionQueries.decisions.data?.decisions ?? [], [attentionQueries.decisions.data])
  const humanOwnedConversations = useMemo(
    () => selectHumanOwnedConversations(attentionQueries.humanOwned.data?.conversations ?? []),
    [attentionQueries.humanOwned.data],
  )
  const qualityPresentation = useMemo(() => qualityInboxPresentation(qualitySnapshot), [qualitySnapshot])
  const qualityTurns = useMemo(
    () => qualityPresentation.turns.filter((turn) => !terminalQualityMessageIds.has(turn.assistantMessageId)),
    [qualityPresentation.turns, terminalQualityMessageIds],
  )
  const inboxModel = useMemo(
    () => buildInboxModel({ decisions, conversations: humanOwnedConversations, qualityTurns }),
    [decisions, humanOwnedConversations, qualityTurns],
  )
  const items = inboxModel.items
  const criticalOpenCount = useMemo(
    () => items.reduce((count, item) => count + (item.severity === 'critical' ? 1 : 0), 0),
    [items],
  )

  // Tab title reflects every open item; the chime is critical-only (handoffs +
  // approvals) - written feedback moves the count but stays quiet.
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
    || attentionQueries.commentedFeedback.isLoading
    || attentionQueries.reviewSummary.isLoading
  )
  const approvalError = attentionQueries.decisions.error
    ? getApiErrorMessage(attentionQueries.decisions.error, 'Failed to load pending approvals.')
    : null
  const conversationError = attentionQueries.humanOwned.error
    ? getApiErrorMessage(attentionQueries.humanOwned.error, 'Failed to load human-owned conversations.')
    : null

  const typeCounts = useMemo(() => countInboxItemsByType(items), [items])
  const workspaceAgentOptions = useInboxAgentOptions(Boolean(workspaceId))
  const queueAgentOptions = useMemo(() => listInboxAgents(items), [items])
  const agentOptions = workspaceAgentOptions.length > 0 ? workspaceAgentOptions : queueAgentOptions
  const operatorOptions = useMemo(() => listTakenByOperators(items), [items])
  const filteredItems = useMemo(
    () => filterInboxItems(items, filters, { currentAccountId: accountId }),
    [items, filters, accountId],
  )

  const recentlyClosed = useInboxRecentlyClosed(workspaceId)
  const filteredRecentlyClosed = useMemo(() => {
    const query = filters.search.trim().toLowerCase()
    return query.length === 0
      ? recentlyClosed
      : recentlyClosed.filter((item) => item.title.toLowerCase().includes(query))
  }, [recentlyClosed, filters.search])

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
        setSelectedInboxItem((current2) =>
          current2?.type === 'negative_feedback' && current2.assistantMessageId === messageId ? null : current2)
        setStatusAnnouncement('Another operator already closed this feedback. It was removed from the inbox.')
      } else {
        setQualitySnapshot((previous) =>
          updateQualityInboxTurn(previous, messageId, (turn) => ({ ...turn, triage: current })))
        patchLatestQuality(messageId, current, false)
      }
    }
  }, [patchLatestQuality])

  const handleSelectItem = useCallback((item: InboxItem) => {
    setSelectedInboxItem(item)
    if (item.type === 'negative_feedback' && item.triageState === 'open') {
      void handleAcknowledge(item)
    }
  }, [handleAcknowledge])

  const handleOperatorChanged = useCallback(async (result: OperatorActionResult) => {
    if (result.kind === 'ownership') {
      invalidateDashboardQueries(['conversation.ownership_changed'])
      if (result.ownershipState === 'ai_owned') {
        // A hand-back just closed this handoff item - Done's single wrap-up
        // action, so clear the selection and let the operator pick the next one.
        setSelectedInboxItem((current) =>
          current?.type === 'handoff' && current.conversationId === result.conversationId ? null : current)
      }
    } else if (result.kind === 'decision_resolved') {
      invalidateDashboardQueries(['hitl.decision_resolved'])
      // Only the selected approval can produce this result (decision buttons
      // render only for the item currently open in the response view).
      setSelectedInboxItem((current) => current?.type === 'approval' ? null : current)
    } else if (result.kind === 'refresh') {
      invalidateDashboardQueries(
        result.reason === 'conflict' ? ['conversation.ownership_changed'] : ['hitl.decision_resolved'],
      )
    } else if (result.kind === 'reply') {
      // A reply can implicitly claim the conversation (FR-009); invalidate
      // ownership so a teammate's queue reflects the claim without waiting on
      // the next poll cycle.
      invalidateDashboardQueries(['conversation.ownership_changed'])
    }
  }, [invalidateDashboardQueries])

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
      setSelectedInboxItem((current) => current?.key === item.key ? null : current)
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
  }, [closeReview, patchLatestQuality])

  const debugSelectedItem: SelectedHistoryItem = useMemo(
    () => debugConversationId ? { kind: 'chat', id: debugConversationId } : null,
    [debugConversationId],
  )
  // A queue with zero open items still renders the full two-pane shell (the
  // lens toggle lives in the left pane) — only the row list swaps for the
  // confidence message, so the operator can always reach the All lens even
  // when nothing needs them (spec 1116 unification, fix for issue #6).
  const isQueueEmpty = !isLoading && !approvalError && !conversationError && items.length === 0
  const showNoFilterMatches = !isQueueEmpty && filteredItems.length === 0 && !selectedInboxItem

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
  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      const decision = decideDefaultInboxLens({
        activityTab: routeState.activityTab,
        alreadyDecided: hasAppliedDefaultLensRef.current,
        isLoading,
        hasError: hasBlockingInboxLoadError({
          approvalError: Boolean(approvalError),
          conversationError: Boolean(conversationError),
          qualityLoadFailed: qualityPresentation.hasLoadFailure,
          qualityPermissionDenied: qualityPresentation.permissionDenied,
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
    qualityPresentation.hasLoadFailure,
    qualityPresentation.permissionDenied,
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
              onSelect={handleSelectItem}
            />
            {showNoFilterMatches ? (
              <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                No items match your filters.
              </div>
            ) : (
              <InboxResponseView
                selection={selectedInboxItem ? { source: 'item', item: selectedInboxItem } : null}
                now={now}
                pendingDecisions={decisions}
                onOperatorChanged={handleOperatorChanged}
                onRequestFeedbackClose={requestCloseReview}
                onOpenDebugView={setDebugConversationId}
                emptyPlaceholder={isQueueEmpty ? (
                  <InboxEmptyState
                    qualityReviewHref={qualityReviewHref}
                    untriagedQualityCount={qualityPresentation.reviewCount}
                    qualityPermissionDenied={qualityPresentation.permissionDenied}
                    qualityLoadFailed={qualityPresentation.hasLoadFailure}
                  />
                ) : undefined}
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
