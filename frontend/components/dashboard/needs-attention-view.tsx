'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'

import { ActivityTabs } from './activity-tabs'
import { ConversationDrawer } from './conversation-drawer'
import { DashboardPage } from '@/components/dashboard/shared/dashboard-page'
import { DashboardTable, DashboardTableBody, DashboardTableCell, DashboardTableHead, DashboardTableHeader, DashboardTableRow } from '@/components/dashboard/shared/dashboard-table'
import type { SelectedHistoryItem } from '@/components/dashboard/history/history-list'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useNeedsAttentionActivity } from '@/hooks/use-needs-attention-activity'
import { chatApi, qualityApi, skillsApi, type LowQualityTurn, type PendingApprovalDecision, type QualityTriageState } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { hitlApi } from '@/lib/api-hitl'
import { buildDashboardHref, type DashboardRouteState } from '@/lib/dashboard-routes'
import { ACTIVE_TRIAGE_STATES, groundingGapActions } from '@/lib/quality-signals'
import { cn } from '@/lib/utils'
import {
  buildInboxItems,
  HUMAN_OWNED_CONVERSATION_PAGE_SIZE,
  inboxItemKeys,
  type EscalationType,
  type HumanOwnedConversationSummary,
  type InboxItem,
  selectHumanOwnedConversations,
} from '@/lib/needs-attention'

interface NeedsAttentionViewProps {
  accountId: string
  routeState: DashboardRouteState
}

// Cap the lower-concern quality signals pulled into the live inbox so they never crowd out
// critical escalations. The Quality view remains the full, paginated backlog.
const QUALITY_INBOX_LIMIT = 25

const ESCALATION_META: Record<EscalationType, { label: string; className: string }> = {
  approval: { label: 'Approval', className: 'border-destructive/40 bg-destructive/10 text-destructive' },
  handoff: { label: 'Handoff', className: 'border-destructive/40 bg-destructive/10 text-destructive' },
  degraded: { label: 'Degraded', className: 'border-amber-400/40 bg-amber-100/50 text-amber-700 dark:text-amber-300' },
  no_context: { label: 'No context', className: 'border-amber-400/40 bg-amber-100/50 text-amber-700 dark:text-amber-300' },
}

const relativeTimeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

export const formatApprovalCreatedAt = (createdAt: string, now = new Date()): string => {
  const created = new Date(createdAt)
  if (Number.isNaN(created.getTime())) {
    return createdAt
  }

  const diffSeconds = Math.round((created.getTime() - now.getTime()) / 1000)
  const absSeconds = Math.abs(diffSeconds)
  if (absSeconds < 60) {
    return relativeTimeFormatter.format(diffSeconds, 'second')
  }

  const diffMinutes = Math.round(diffSeconds / 60)
  const absMinutes = Math.abs(diffMinutes)
  if (absMinutes < 60) {
    return relativeTimeFormatter.format(diffMinutes, 'minute')
  }

  const diffHours = Math.round(diffMinutes / 60)
  const absHours = Math.abs(diffHours)
  if (absHours < 24) {
    return relativeTimeFormatter.format(diffHours, 'hour')
  }

  return relativeTimeFormatter.format(Math.round(diffHours / 24), 'day')
}

function EscalationBadge({ type }: { type: EscalationType }) {
  const meta = ESCALATION_META[type]
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium',
        meta.className,
      )}
    >
      {meta.label}
    </span>
  )
}

function InboxRow({
  item,
  onSelect,
  onTriage,
  isTriaging,
}: {
  item: InboxItem
  onSelect: (item: InboxItem) => void
  onTriage: (item: InboxItem, state: QualityTriageState) => void
  isTriaging: boolean
}) {
  return (
    <DashboardTableRow>
      <DashboardTableCell className="w-32">
        <EscalationBadge type={item.type} />
      </DashboardTableCell>
      <DashboardTableCell>
        <button
          type="button"
          onClick={() => onSelect(item)}
          className="block max-w-full text-left text-sm font-medium leading-5 text-foreground hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <span className="block truncate">{item.title}</span>
        </button>
      </DashboardTableCell>
      <DashboardTableCell className="w-48 text-sm text-muted-foreground">
        <span className="block truncate">{item.detail}</span>
      </DashboardTableCell>
      <DashboardTableCell className="w-40 text-sm text-muted-foreground">
        {formatApprovalCreatedAt(item.timestamp)}
      </DashboardTableCell>
      <DashboardTableCell className="w-32">
        {item.assistantMessageId ? (
          // Quality signals clear with a single Dismiss (sets the turn's triage state so
          // it drops out of the inbox). Approvals/handoffs clear from the conversation
          // drawer instead, so their action cell stays empty.
          <div className="flex justify-end">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isTriaging}
              onClick={() => onTriage(item, 'dismissed')}
            >
              Dismiss
            </Button>
          </div>
        ) : null}
      </DashboardTableCell>
    </DashboardTableRow>
  )
}

export function NeedsAttentionView({ accountId, routeState }: NeedsAttentionViewProps) {
  const [decisions, setDecisions] = useState<PendingApprovalDecision[]>([])
  const [humanOwnedConversations, setHumanOwnedConversations] = useState<HumanOwnedConversationSummary[]>([])
  const [qualityTurns, setQualityTurns] = useState<LowQualityTurn[]>([])
  const [selectedItem, setSelectedItem] = useState<SelectedHistoryItem>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [approvalError, setApprovalError] = useState<string | null>(null)
  const [conversationError, setConversationError] = useState<string | null>(null)
  const isMountedRef = useRef(false)
  const inboxRequestIdRef = useRef(0)

  const refreshInbox = useCallback(async () => {
    const requestId = inboxRequestIdRef.current + 1
    inboxRequestIdRef.current = requestId

    // Quality signals are lower concern and best-effort: a failure here never blocks the
    // inbox or surfaces an error, it just omits the quality rows.
    const loadQualityTurns = async (): Promise<LowQualityTurn[]> => {
      const { skills } = await skillsApi.list()
      const actions = groundingGapActions(skills)
      if (actions.length === 0) {
        return []
      }
      const page = await qualityApi.listTurns({
        actions,
        triageStates: [...ACTIVE_TRIAGE_STATES],
        limit: QUALITY_INBOX_LIMIT,
      })
      return page.items
    }

    const [approvalsResult, conversationsResult, qualityResult] = await Promise.allSettled([
      hitlApi.listPendingDecisions(),
      chatApi.listChatHistory({
        limit: HUMAN_OWNED_CONVERSATION_PAGE_SIZE,
        offset: 0,
      }),
      loadQualityTurns(),
    ])

    if (!isMountedRef.current || requestId !== inboxRequestIdRef.current) {
      return
    }

    if (approvalsResult.status === 'fulfilled') {
      setDecisions(approvalsResult.value.decisions)
      setApprovalError(null)
    } else {
      setApprovalError(
        approvalsResult.reason instanceof Error
          ? approvalsResult.reason.message
          : 'Failed to load pending approvals.',
      )
    }

    if (conversationsResult.status === 'fulfilled') {
      setHumanOwnedConversations(selectHumanOwnedConversations(conversationsResult.value.conversations))
      setConversationError(null)
    } else {
      setHumanOwnedConversations([])
      setConversationError(getApiErrorMessage(conversationsResult.reason, 'Failed to load human-owned conversations.'))
    }

    setQualityTurns(qualityResult.status === 'fulfilled' ? qualityResult.value : [])

    setIsLoading(false)
  }, [])

  useEffect(() => {
    isMountedRef.current = true

    const loadInitialInbox = async () => {
      await refreshInbox()
    }

    void loadInitialInbox()
    return () => {
      isMountedRef.current = false
      inboxRequestIdRef.current += 1
    }
  }, [refreshInbox])

  const handleSelectedItemChange = useCallback((next: SelectedHistoryItem) => {
    setSelectedItem(next)
  }, [])

  const handleDrawerClosed = useCallback(() => {
    setSelectedItem(null)
    void refreshInbox()
  }, [refreshInbox])

  const handleSelectItem = useCallback((item: InboxItem) => {
    setSelectedItem({ kind: 'chat', id: item.conversationId })
  }, [])

  const [triagingMessageIds, setTriagingMessageIds] = useState<ReadonlySet<string>>(new Set())

  const handleTriage = useCallback(async (item: InboxItem, state: QualityTriageState) => {
    const messageId = item.assistantMessageId
    if (!messageId) {
      return
    }
    setTriagingMessageIds((prev) => new Set(prev).add(messageId))
    // Optimistically drop the row; restore from the server on failure.
    setQualityTurns((prev) => prev.filter((turn) => turn.assistantMessageId !== messageId))
    try {
      await qualityApi.setTriageState(messageId, { state })
    } catch {
      if (isMountedRef.current) {
        void refreshInbox()
      }
    } finally {
      if (isMountedRef.current) {
        setTriagingMessageIds((prev) => {
          const next = new Set(prev)
          next.delete(messageId)
          return next
        })
      }
    }
  }, [refreshInbox])

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

  const items = useMemo(
    () => buildInboxItems({ decisions, conversations: humanOwnedConversations, qualityTurns }),
    [decisions, humanOwnedConversations, qualityTurns],
  )
  const needsAttentionCount = items.length

  // The activity indicator tracks critical escalations only; lower-concern quality signals
  // refresh on manual refresh / drawer close so they never spam the "new activity" badge.
  const baselineKeys = useMemo(
    () => (isLoading ? null : inboxItemKeys(decisions, humanOwnedConversations)),
    [decisions, humanOwnedConversations, isLoading],
  )
  const newItemCount = useNeedsAttentionActivity({
    baselineKeys,
    // Pause the background poll while a conversation is open; closing it already triggers a refresh.
    enabled: selectedItem === null,
  })
  const hasNewActivity = newItemCount > 0

  const handleRefresh = useCallback(() => {
    void refreshInbox()
  }, [refreshInbox])

  const showEmptyState = !isLoading && !approvalError && !conversationError && items.length === 0

  return (
    <>
      <DashboardPage
        title="Needs attention"
        description={`${needsAttentionCount} item${needsAttentionCount === 1 ? '' : 's'} needing operator attention`}
        actions={
          <>
            <Button
              type="button"
              variant={hasNewActivity ? 'default' : 'outline'}
              size="sm"
              onClick={handleRefresh}
              disabled={isLoading}
            >
              <RefreshCw className="h-4 w-4" aria-hidden />
              {hasNewActivity ? `Refresh (${newItemCount})` : 'Refresh'}
            </Button>
            <ActivityTabs accountId={accountId} routeState={routeState} />
          </>
        }
      >
        <div className="space-y-4">
          {approvalError ? (
            <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
              {approvalError}
            </div>
          ) : null}
          {conversationError ? (
            <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
              {conversationError}
            </div>
          ) : null}

          {isLoading ? (
            <div className="space-y-3">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : showEmptyState ? (
            <div className="rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground">
              Nothing needs attention.
            </div>
          ) : items.length > 0 ? (
            <DashboardTable aria-label="Needs attention" minWidth="min-w-[900px]">
              <DashboardTableHead>
                <DashboardTableHeader className="w-32">Type</DashboardTableHeader>
                <DashboardTableHeader>Item</DashboardTableHeader>
                <DashboardTableHeader className="w-48">Detail</DashboardTableHeader>
                <DashboardTableHeader className="w-40">Updated</DashboardTableHeader>
                <DashboardTableHeader className="w-32">
                  <span className="sr-only">Actions</span>
                </DashboardTableHeader>
              </DashboardTableHead>
              <DashboardTableBody>
                {items.map((item) => (
                  <InboxRow
                    key={item.key}
                    item={item}
                    onSelect={handleSelectItem}
                    onTriage={handleTriage}
                    isTriaging={item.assistantMessageId ? triagingMessageIds.has(item.assistantMessageId) : false}
                  />
                ))}
              </DashboardTableBody>
            </DashboardTable>
          ) : null}
        </div>
      </DashboardPage>

      <ConversationDrawer
        selectedItem={selectedItem}
        onSelectedItemChange={handleSelectedItemChange}
        anchorMessageId={routeState.historyMessageId}
        onAfterClose={handleDrawerClosed}
        onOperatorChanged={refreshInbox}
        pendingDecisions={decisions}
        buildRoutineHref={buildRoutineHref}
      />
    </>
  )
}
