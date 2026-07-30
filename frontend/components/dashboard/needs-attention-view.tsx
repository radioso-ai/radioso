'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown,
  Copy,
  ExternalLink,
  MoreHorizontal,
  RefreshCw,
} from 'lucide-react'

import { ConversationDrawer } from './conversation-drawer'
import {
  CloseReviewPopover,
  type CloseReviewInput,
} from '@/components/dashboard/quality/close-review-popover'
import { DashboardPage } from '@/components/dashboard/shared/dashboard-page'
import { DashboardTable, DashboardTableBody, DashboardTableCell, DashboardTableHead, DashboardTableHeader, DashboardTableRow } from '@/components/dashboard/shared/dashboard-table'
import type { SelectedHistoryItem } from '@/components/dashboard/history/history-list'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { LogoSpinner } from '@/components/ui/spinner'
import { useNeedsAttentionActivity } from '@/hooks/use-needs-attention-activity'
import {
  chatApi,
  getQualityTriageConflict,
  qualityApi,
  type PendingApprovalDecision,
  type QualityTriageRecord,
  type QualityTriageState,
} from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { hitlApi } from '@/lib/api-hitl'
import { buildDashboardHref, type DashboardRouteState } from '@/lib/dashboard-routes'
import { ACTIVE_TRIAGE_STATES } from '@/lib/quality-signals'
import { cn } from '@/lib/utils'
import {
  buildInboxModel,
  formatInboxDuration,
  HUMAN_OWNED_CONVERSATION_PAGE_SIZE,
  inboxItemKeys,
  type EscalationType,
  type HumanOwnedConversationSummary,
  type InboxItem,
  selectHumanOwnedConversations,
  waitingTone,
} from '@/lib/needs-attention'
import {
  createEmptyQualityInboxSnapshot,
  loadQualityInboxSourceAttempts,
  qualityInboxPresentation,
  reduceQualityInboxSnapshot,
  removeQualityInboxTurn,
  updateQualityInboxTurn,
} from '@/lib/needs-attention-quality'

interface NeedsAttentionViewProps {
  accountId: string
  routeState: DashboardRouteState
}

const ESCALATION_META: Record<EscalationType, { label: string; className: string }> = {
  approval: { label: 'Approval', className: 'border-destructive/40 bg-destructive/10 text-destructive' },
  handoff: { label: 'Handoff', className: 'border-destructive/40 bg-destructive/10 text-destructive' },
  negative_feedback: { label: 'Negative feedback', className: 'border-border bg-background text-foreground' },
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

type CopyStatus = 'idle' | 'copied' | 'error'

function RemediationActions({
  item,
  knowledgeHref,
  behaviorHref,
  agentChatHref,
  isTriaging,
  copyStatus,
  acknowledgementPending,
  acknowledgementError,
  triageError,
  onCopyQuestion,
  onResolve,
  onDismiss,
}: {
  item: InboxItem
  knowledgeHref: string
  behaviorHref: string | null
  agentChatHref: string | null
  isTriaging: boolean
  copyStatus: CopyStatus
  acknowledgementPending: boolean
  acknowledgementError: string | null
  triageError: string | null
  onCopyQuestion: () => void
  onResolve: (anchor: HTMLElement) => void
  onDismiss: (anchor: HTMLElement | null) => void
}) {
  const unavailableAgentHelpId = `feedback-agent-unavailable-${item.assistantMessageId}`
  const moreActionsRef = useRef<HTMLButtonElement>(null)

  return (
    <div className="space-y-3">
      <div>
        <p className="text-xs font-medium uppercase tracking-normal text-muted-foreground">
          Why this needs attention
        </p>
        <p className="mt-1 text-sm text-foreground">
          A customer explicitly marked this answer unhelpful.
        </p>
        <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">
          {item.feedbackComment ?? 'No written comment was left.'}
        </p>
      </div>

      {acknowledgementPending ? (
        <p className="text-xs text-muted-foreground" role="status" aria-live="polite">
          Marking this feedback as reviewed…
        </p>
      ) : null}
      {acknowledgementError ? (
        <p className="text-xs text-destructive" role="status" aria-live="polite">
          {acknowledgementError}
        </p>
      ) : null}

      <div className="grid gap-2 sm:grid-cols-2 lg:flex lg:flex-wrap">
        <Button asChild size="sm" className="min-h-11 gap-1.5 sm:min-h-9">
          <a href={knowledgeHref} target="_blank" rel="noreferrer">
            Add knowledge
            <ExternalLink className="h-3.5 w-3.5" aria-hidden />
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        </Button>
        {behaviorHref ? (
          <Button asChild size="sm" variant="outline" className="min-h-11 gap-1.5 sm:min-h-9">
            <a href={behaviorHref} target="_blank" rel="noreferrer">
              Improve behavior
              <ExternalLink className="h-3.5 w-3.5" aria-hidden />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="min-h-11 sm:min-h-9"
            aria-disabled="true"
            aria-describedby={unavailableAgentHelpId}
            onClick={(event) => event.preventDefault()}
          >
            Improve behavior
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="min-h-11 gap-1.5 sm:min-h-9"
          onClick={onCopyQuestion}
        >
          <Copy className="h-3.5 w-3.5" aria-hidden />
          Copy question
        </Button>
        {agentChatHref ? (
          <Button asChild size="sm" variant="outline" className="min-h-11 gap-1.5 sm:min-h-9">
            <a href={agentChatHref} target="_blank" rel="noreferrer">
              Open agent chat
              <ExternalLink className="h-3.5 w-3.5" aria-hidden />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          </Button>
        ) : null}
      </div>

      {!behaviorHref ? (
        <p id={unavailableAgentHelpId} className="text-xs text-muted-foreground">
          The originating agent is no longer available. You can still add workspace knowledge.
        </p>
      ) : null}
      {copyStatus !== 'idle' ? (
        <p
          className={cn(
            'text-xs',
            copyStatus === 'error' ? 'text-destructive' : 'text-muted-foreground',
          )}
          role="status"
          aria-live="polite"
        >
          {copyStatus === 'copied'
            ? 'Question copied.'
            : 'Could not copy the question. Select it from the conversation instead.'}
        </p>
      ) : null}

      <div className="flex flex-col gap-2 border-t border-border/70 pt-3 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">Close the loop</p>
          <p className="text-xs text-muted-foreground">
            Update the source or behavior, test from the agent chat, then mark this resolved.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            aria-haspopup="dialog"
            size="sm"
            variant="outline"
            className="min-h-11 sm:min-h-9"
            disabled={isTriaging || acknowledgementPending}
            onClick={(event) => onResolve(event.currentTarget)}
          >
            Mark resolved
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                ref={moreActionsRef}
                type="button"
                size="icon"
                variant="ghost"
                className="h-11 w-11 sm:h-9 sm:w-9"
                disabled={isTriaging || acknowledgementPending}
                aria-label="More feedback actions"
              >
                <MoreHorizontal className="h-4 w-4" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => onDismiss(moreActionsRef.current)}>
                Not actionable
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {triageError ? (
        <p className="text-xs text-destructive" role="status" aria-live="polite">
          {triageError}
        </p>
      ) : null}
    </div>
  )
}

function NegativeFeedbackAccessory({
  item,
  knowledgeHref,
  behaviorHref,
  agentChatHref,
  isTriaging,
  copyStatus,
  acknowledgementPending,
  acknowledgementError,
  triageError,
  onCopyQuestion,
  onResolve,
  onDismiss,
}: {
  item: InboxItem
  knowledgeHref: string
  behaviorHref: string | null
  agentChatHref: string | null
  isTriaging: boolean
  copyStatus: CopyStatus
  acknowledgementPending: boolean
  acknowledgementError: string | null
  triageError: string | null
  onCopyQuestion: () => void
  onResolve: (anchor: HTMLElement) => void
  onDismiss: (anchor: HTMLElement | null) => void
}) {
  const [mobileOpen, setMobileOpen] = useState(true)
  const contentProps = {
    item,
    knowledgeHref,
    behaviorHref,
    agentChatHref,
    isTriaging,
    copyStatus,
    acknowledgementPending,
    acknowledgementError,
    triageError,
    onCopyQuestion,
    onResolve,
    onDismiss,
  }

  return (
    <section
      className="shrink-0 border-b border-border bg-muted/20"
      aria-label="Negative feedback remediation"
    >
      <button
        type="button"
        className="flex min-h-11 w-full items-center justify-between gap-3 px-4 py-2 text-left text-sm font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring md:hidden"
        aria-expanded={mobileOpen}
        aria-controls="negative-feedback-remediation-content"
        onClick={() => setMobileOpen((current) => !current)}
      >
        <span>Negative feedback</span>
        <ChevronDown
          className={cn('h-4 w-4 transition-transform', mobileOpen && 'rotate-180')}
          aria-hidden
        />
      </button>
      <div
        id="negative-feedback-remediation-content"
        className={cn(
          'max-h-[60svh] overflow-y-auto px-4 pb-4 md:block md:max-h-none md:overflow-visible md:py-3',
          mobileOpen ? 'block' : 'hidden',
        )}
      >
        <h2 className="sr-only" tabIndex={-1} data-feedback-heading>
          Negative feedback remediation
        </h2>
        <RemediationActions {...contentProps} />
      </div>
    </section>
  )
}

function InboxRow({
  item,
  now,
  onReview,
  onTriage,
  isTriaging,
  reviewButtonRef,
}: {
  item: InboxItem
  now: Date
  onReview: (item: InboxItem) => void
  onTriage: (
    item: InboxItem,
    state: QualityTriageState,
    anchor: HTMLElement | null,
  ) => void
  isTriaging: boolean
  reviewButtonRef?: (node: HTMLButtonElement | null) => void
}) {
  const isTakenOverHandoff = item.type === 'handoff' && item.takenOverAt !== null && item.takenOverAt !== undefined
  const durationStart = isTakenOverHandoff ? item.takenOverAt : item.escalatedAt
  const elapsedMs = durationStart
    ? Math.max(0, now.getTime() - new Date(durationStart).getTime())
    : 0
  const timeLabel = item.severity === 'critical'
    ? `${isTakenOverHandoff ? 'With them' : 'Waiting'} ${formatInboxDuration(elapsedMs)}`
    : formatApprovalCreatedAt(item.timestamp, now)
  const tone = waitingTone(elapsedMs)

  return (
    <DashboardTableRow>
      <DashboardTableCell className="w-32">
        <EscalationBadge type={item.type} />
      </DashboardTableCell>
      <DashboardTableCell>
        {item.type === 'negative_feedback' ? (
          <div className="min-w-0">
            <span className="block truncate text-sm font-medium leading-5 text-foreground">
              {item.title}
            </span>
            {item.agentName ? (
              <span className="block truncate text-xs text-muted-foreground">{item.agentName}</span>
            ) : null}
          </div>
        ) : (
          <button
            ref={reviewButtonRef}
            type="button"
            onClick={() => onReview(item)}
            className="block max-w-full text-left text-sm font-medium leading-5 text-foreground hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <span className="block truncate">{item.title}</span>
          </button>
        )}
      </DashboardTableCell>
      <DashboardTableCell className="w-48 text-sm text-muted-foreground">
        <span className="block truncate">{item.detail}</span>
      </DashboardTableCell>
      <DashboardTableCell
        className={cn(
          'w-40 text-sm',
          item.severity !== 'critical' || isTakenOverHandoff || tone === 'default'
            ? 'text-muted-foreground'
            : tone === 'amber'
              ? 'font-medium text-amber-700 dark:text-amber-300'
              : 'font-medium text-destructive',
        )}
      >
        {timeLabel}
      </DashboardTableCell>
      <DashboardTableCell className="w-32">
        {item.type === 'negative_feedback' ? (
          <div className="flex justify-end">
            <Button
              ref={reviewButtonRef}
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onReview(item)}
              aria-label={`Review feedback: ${item.title}`}
            >
              Review
            </Button>
          </div>
        ) : item.assistantMessageId ? (
          // Quality signals close through the shared reason dialog. Approvals and
          // handoffs clear from the conversation drawer, so their action cell stays empty.
          <div className="flex justify-end">
            <Button
              type="button"
              aria-haspopup="dialog"
              variant="outline"
              size="sm"
              disabled={isTriaging}
              onClick={(event) => onTriage(item, 'dismissed', event.currentTarget)}
            >
              Dismiss
            </Button>
          </div>
        ) : null}
      </DashboardTableCell>
    </DashboardTableRow>
  )
}

function MobileInboxRow({
  item,
  now,
  onReview,
  onTriage,
  isTriaging,
  reviewButtonRef,
}: {
  item: InboxItem
  now: Date
  onReview: (item: InboxItem) => void
  onTriage: (
    item: InboxItem,
    state: QualityTriageState,
    anchor: HTMLElement | null,
  ) => void
  isTriaging: boolean
  reviewButtonRef?: (node: HTMLButtonElement | null) => void
}) {
  const isTakenOverHandoff = item.type === 'handoff'
    && item.takenOverAt !== null
    && item.takenOverAt !== undefined
  const durationStart = isTakenOverHandoff ? item.takenOverAt : item.escalatedAt
  const elapsedMs = durationStart
    ? Math.max(0, now.getTime() - new Date(durationStart).getTime())
    : 0
  const timeLabel = item.severity === 'critical'
    ? `${isTakenOverHandoff ? 'With them' : 'Waiting'} ${formatInboxDuration(elapsedMs)}`
    : formatApprovalCreatedAt(item.timestamp, now)

  return (
    <article className="space-y-2 border-b border-border p-4 last:border-b-0">
      <div className="flex items-center justify-between gap-3">
        <EscalationBadge type={item.type} />
        <span className="text-xs text-muted-foreground">{timeLabel}</span>
      </div>
      <p className="line-clamp-2 text-sm font-medium text-foreground">{item.title}</p>
      <p className="line-clamp-2 text-sm text-muted-foreground">
        {item.type === 'negative_feedback'
          ? item.feedbackComment ?? 'No written comment'
          : item.detail}
      </p>
      <div className="flex min-h-11 items-center justify-between gap-3">
        <span className="truncate text-xs text-muted-foreground">
          {item.agentName ?? (item.type === 'handoff' ? item.detail : '')}
        </span>
        <div className="flex items-center gap-2">
          <Button
            ref={reviewButtonRef}
            type="button"
            size="sm"
            variant="outline"
            className="min-h-11"
            onClick={() => onReview(item)}
            aria-label={item.type === 'negative_feedback'
              ? `Review feedback: ${item.title}`
              : `Review: ${item.title}`}
          >
            Review
          </Button>
          {item.assistantMessageId && item.type !== 'negative_feedback' ? (
            <Button
              type="button"
              aria-haspopup="dialog"
              size="sm"
              variant="ghost"
              className="min-h-11"
              disabled={isTriaging}
              onClick={(event) => onTriage(item, 'dismissed', event.currentTarget)}
            >
              Dismiss
            </Button>
          ) : null}
        </div>
      </div>
    </article>
  )
}

export function NeedsAttentionView({ accountId, routeState }: NeedsAttentionViewProps) {
  const [decisions, setDecisions] = useState<PendingApprovalDecision[]>([])
  const [humanOwnedConversations, setHumanOwnedConversations] = useState<HumanOwnedConversationSummary[]>([])
  const [qualitySnapshot, setQualitySnapshot] = useState(createEmptyQualityInboxSnapshot)
  const [selectedInboxItem, setSelectedInboxItem] = useState<InboxItem | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [approvalError, setApprovalError] = useState<string | null>(null)
  const [conversationError, setConversationError] = useState<string | null>(null)
  const [acknowledgingMessageId, setAcknowledgingMessageId] = useState<string | null>(null)
  const [acknowledgementError, setAcknowledgementError] = useState<string | null>(null)
  const [triageError, setTriageError] = useState<string | null>(null)
  const [closeReview, setCloseReview] = useState<{
    item: InboxItem
    state: 'resolved' | 'dismissed'
    conflict: QualityTriageRecord | null
    anchor: HTMLElement | null
  } | null>(null)
  const [copyStatus, setCopyStatus] = useState<CopyStatus>('idle')
  const [statusAnnouncement, setStatusAnnouncement] = useState('')
  const [focusAfterTriageKey, setFocusAfterTriageKey] = useState<string | 'page' | null>(null)
  const [now, setNow] = useState(() => new Date())
  const isMountedRef = useRef(false)
  const inboxRequestIdRef = useRef(0)
  const pageTitleRef = useRef<HTMLSpanElement | null>(null)
  const returnFocusKeyRef = useRef<string | null>(null)
  const reviewButtonRefs = useRef(new Map<string, {
    desktop?: HTMLButtonElement
    mobile?: HTMLButtonElement
  }>())

  const refreshInbox = useCallback(async () => {
    const requestId = inboxRequestIdRef.current + 1
    inboxRequestIdRef.current = requestId

    const [approvalsResult, conversationsResult, qualityResult] = await Promise.allSettled([
      hitlApi.listPendingDecisions(),
      chatApi.listChatHistory({
        limit: HUMAN_OWNED_CONVERSATION_PAGE_SIZE,
        offset: 0,
        ownership: 'human_owned',
      }),
      loadQualityInboxSourceAttempts(),
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

    if (qualityResult.status === 'fulfilled') {
      setQualitySnapshot((previous) =>
        reduceQualityInboxSnapshot(previous, qualityResult.value))
    }

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

  useEffect(() => {
    const intervalId = window.setInterval(() => setNow(new Date()), 30_000)
    return () => window.clearInterval(intervalId)
  }, [])

  const qualityPresentation = useMemo(
    () => qualityInboxPresentation(qualitySnapshot),
    [qualitySnapshot],
  )
  const qualityTurns = qualityPresentation.turns
  const inboxModel = useMemo(
    () => buildInboxModel({
      decisions,
      conversations: humanOwnedConversations,
      qualityTurns,
    }),
    [decisions, humanOwnedConversations, qualityTurns],
  )
  const items = inboxModel.items
  const selectedHistoryItem = useMemo<SelectedHistoryItem>(
    () => selectedInboxItem
      ? { kind: 'chat', id: selectedInboxItem.conversationId }
      : null,
    [selectedInboxItem],
  )

  const handleSelectedItemChange = useCallback((next: SelectedHistoryItem) => {
    if (next === null) {
      setSelectedInboxItem(null)
    }
  }, [])

  const handleDrawerClosed = useCallback(() => {
    const returnFocusKey = returnFocusKeyRef.current
    returnFocusKeyRef.current = null
    setSelectedInboxItem(null)
    setAcknowledgementError(null)
    setTriageError(null)
    setCopyStatus('idle')
    if (returnFocusKey) {
      setFocusAfterTriageKey(returnFocusKey)
    }
    void refreshInbox()
  }, [refreshInbox])

  const [triagingMessageIds, setTriagingMessageIds] = useState<ReadonlySet<string>>(new Set())

  const handleAcknowledge = useCallback(async (item: InboxItem) => {
    const messageId = item.assistantMessageId
    if (!messageId || item.type !== 'negative_feedback' || item.triageState !== 'open') {
      return
    }

    setAcknowledgingMessageId(messageId)
    setAcknowledgementError(null)
    try {
      const triage = await qualityApi.setTriageState(messageId, {
        state: 'acknowledged',
        expectedVersion: item.triage?.version ?? 0,
      })
      if (!isMountedRef.current) {
        return
      }
      setQualitySnapshot((previous) =>
        updateQualityInboxTurn(previous, messageId, (turn) => ({
          ...turn,
          triage,
        })))
      setSelectedInboxItem((current) =>
        current?.assistantMessageId === messageId
          ? { ...current, triageState: triage.state, triage }
          : current)
    } catch (caught) {
      if (isMountedRef.current) {
        const current = getQualityTriageConflict(caught)
        if (current) {
          setQualitySnapshot((previous) =>
            updateQualityInboxTurn(previous, messageId, (turn) => ({
              ...turn,
              triage: current,
            })))
          setSelectedInboxItem((selected) =>
            selected?.assistantMessageId === messageId
              ? { ...selected, triageState: current.state, triage: current }
              : selected)
          const currentState = current.state === 'dismissed'
            ? 'dismissed as not actionable'
            : current.state
          setAcknowledgementError(
            `Another operator already changed this feedback to ${currentState}. `
              + 'Their current record has been loaded.',
          )
        } else {
          setAcknowledgementError(
            'Could not mark this feedback as reviewed. You can still inspect it and choose a fix.',
          )
        }
      }
    } finally {
      if (isMountedRef.current) {
        setAcknowledgingMessageId((current) => current === messageId ? null : current)
      }
    }
  }, [])

  const handleReviewItem = useCallback((item: InboxItem) => {
    returnFocusKeyRef.current = item.key
    setSelectedInboxItem(item)
    setAcknowledgementError(null)
    setTriageError(null)
    setCopyStatus('idle')
    if (item.type === 'negative_feedback') {
      void handleAcknowledge(item)
      window.requestAnimationFrame(() => {
        document.querySelector<HTMLElement>('[data-feedback-heading]')?.focus()
      })
    }
  }, [handleAcknowledge])

  const requestCloseReview = useCallback((
    item: InboxItem,
    state: QualityTriageState,
    anchor: HTMLElement | null,
  ) => {
    if (state !== 'resolved' && state !== 'dismissed') return
    setTriageError(null)
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        setCloseReview({ item, state, conflict: null, anchor })
      })
    })
  }, [])

  const handleTriage = useCallback(async (input: CloseReviewInput) => {
    const item = closeReview?.item
    if (!item) return
    const messageId = item.assistantMessageId
    if (!messageId) {
      return
    }
    const state = input.state
    const isFeedbackTerminalAction = item.type === 'negative_feedback'
    setTriagingMessageIds((prev) => new Set(prev).add(messageId))
    setTriageError(null)

    try {
      await qualityApi.setTriageState(messageId, {
        state,
        expectedVersion: item.triage?.version ?? 0,
        ...(input.resolution ? { resolution: input.resolution } : {}),
      })
      if (!isMountedRef.current) {
        return
      }

      const currentIndex = items.findIndex((candidate) => candidate.key === item.key)
      const nextItem = items[currentIndex + 1] ?? items[currentIndex - 1]
      returnFocusKeyRef.current = null
      setFocusAfterTriageKey(nextItem?.key ?? 'page')
      setQualitySnapshot((previous) => removeQualityInboxTurn(previous, messageId))
      if (isFeedbackTerminalAction) {
        setSelectedInboxItem(null)
      }
      setCloseReview(null)
      setStatusAnnouncement(
        state === 'resolved' ? 'Marked resolved.' : 'Dismissed as not actionable.',
      )
    } catch (caught) {
      if (isMountedRef.current) {
        const current = getQualityTriageConflict(caught)
        if (current) {
          setQualitySnapshot((previous) =>
            updateQualityInboxTurn(previous, messageId, (turn) => ({ ...turn, triage: current })))
          setSelectedInboxItem((selected) =>
            selected?.assistantMessageId === messageId
              ? { ...selected, triageState: current.state, triage: current }
              : selected)
          setCloseReview((pending) =>
            pending?.item.assistantMessageId === messageId
              ? {
                  ...pending,
                  conflict: current,
                  item: {
                    ...pending.item,
                    triageState: current.state,
                    triage: current,
                  },
                }
              : pending)
          setTriageError(null)
          setStatusAnnouncement(
            'Another operator changed this review. Their current decision is shown in the dialog.',
          )
        } else {
          setTriageError(
            state === 'resolved'
              ? 'Could not mark this feedback as resolved. Try again.'
              : 'Could not dismiss this feedback. Try again.',
          )
        }
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
  }, [closeReview, items])

  const handleCopyQuestion = useCallback(async () => {
    if (!selectedInboxItem || selectedInboxItem.type !== 'negative_feedback') {
      return
    }
    try {
      await navigator.clipboard.writeText(selectedInboxItem.title)
      if (isMountedRef.current) {
        setCopyStatus('copied')
      }
    } catch {
      if (isMountedRef.current) {
        setCopyStatus('error')
      }
    }
  }, [selectedInboxItem])

  const registerReviewButton = useCallback((
    key: string,
    viewport: 'desktop' | 'mobile',
    node: HTMLButtonElement | null,
  ) => {
    const current = reviewButtonRefs.current.get(key) ?? {}
    if (node) {
      reviewButtonRefs.current.set(key, { ...current, [viewport]: node })
      return
    }
    const next = { ...current }
    delete next[viewport]
    if (next.desktop || next.mobile) {
      reviewButtonRefs.current.set(key, next)
    } else {
      reviewButtonRefs.current.delete(key)
    }
  }, [])

  useEffect(() => {
    if (!focusAfterTriageKey || selectedInboxItem) {
      return
    }
    const frame = window.requestAnimationFrame(() => {
      if (focusAfterTriageKey === 'page') {
        pageTitleRef.current?.focus()
      } else {
        const refs = reviewButtonRefs.current.get(focusAfterTriageKey)
        const target = window.matchMedia('(min-width: 768px)').matches
          ? refs?.desktop
          : refs?.mobile
        ;(target ?? pageTitleRef.current)?.focus()
      }
      setFocusAfterTriageKey(null)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [focusAfterTriageKey, selectedInboxItem])

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

  const needsAttentionCount = items.length

  const displayedQualityTurns = useMemo(() => {
    const displayedMessageIds = new Set(
      items.flatMap((item) => item.assistantMessageId ? [item.assistantMessageId] : []),
    )
    return qualityTurns.filter((turn) => displayedMessageIds.has(turn.assistantMessageId))
  }, [items, qualityTurns])

  const baselineKeys = useMemo(
    () => (isLoading ? null : inboxItemKeys(decisions, humanOwnedConversations, displayedQualityTurns)),
    [decisions, displayedQualityTurns, humanOwnedConversations, isLoading],
  )
  const newItemCount = useNeedsAttentionActivity({
    baselineKeys,
    // Pause the background poll while a conversation is open; closing it already triggers a refresh.
    enabled: selectedInboxItem === null,
  })
  const hasNewActivity = newItemCount > 0

  const knowledgeHref = useMemo(
    () => buildDashboardHref(accountId, {
      ...routeState,
      section: 'knowledge',
      knowledgeTab: 'documents',
      documentId: undefined,
      documentsPage: undefined,
      documentSourceFilter: undefined,
      anchor: undefined,
    }),
    [accountId, routeState],
  )
  const behaviorHref = useMemo(
    () => selectedInboxItem?.type === 'negative_feedback' && selectedInboxItem.agentId
      ? buildDashboardHref(accountId, {
          ...routeState,
          section: 'agents',
          agentId: selectedInboxItem.agentId,
          agentTab: 'behavior',
          agentRoutineId: undefined,
          agentChatConversationId: undefined,
          anchor: undefined,
        })
      : null,
    [accountId, routeState, selectedInboxItem],
  )
  const agentChatHref = useMemo(
    () => selectedInboxItem?.type === 'negative_feedback' && selectedInboxItem.agentId
      ? buildDashboardHref(accountId, {
          ...routeState,
          section: 'agents',
          agentId: selectedInboxItem.agentId,
          agentTab: 'chat',
          agentRoutineId: undefined,
          agentChatConversationId: undefined,
          anchor: undefined,
        })
      : null,
    [accountId, routeState, selectedInboxItem],
  )
  const qualityOverflowHref = useMemo(
    () => buildDashboardHref(accountId, {
      ...routeState,
      section: 'quality',
      qualityPage: 1,
      qualityFeedback: ['down'],
      qualitySort: 'negative_feedback_updated_at',
      qualityTriageStates: [...ACTIVE_TRIAGE_STATES],
      qualityActiveNegativeFeedbackOnly: true,
      qualityHasComment: undefined,
      anchor: undefined,
    }),
    [accountId, routeState],
  )

  const handleRefresh = useCallback(() => {
    void refreshInbox()
  }, [refreshInbox])

  const showEmptyState = !isLoading && !approvalError && !conversationError && items.length === 0
  const hasQualityLoadFailure = qualityPresentation.hasLoadFailure
  const hasMoreQualityItems = qualityPresentation.isTruncated || inboxModel.hasMoreQualityItems
  const selectedFeedbackItem = selectedInboxItem?.type === 'negative_feedback'
    ? selectedInboxItem
    : null

  return (
    <>
      <DashboardPage
        title={<span ref={pageTitleRef} tabIndex={-1}>Needs attention</span>}
        description={`${needsAttentionCount} item${needsAttentionCount === 1 ? '' : 's'} needing operator attention`}
        actions={
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
        }
      >
        <div className="space-y-4">
          <p className="sr-only" role="status" aria-live="polite">
            {statusAnnouncement}
          </p>
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
          {qualityPresentation.permissionDenied ? (
            <div className="rounded-lg border border-border bg-muted/20 p-4 text-sm text-muted-foreground">
              Answer feedback is available to workspace admins and owners. Approvals and handoffs are still shown.
            </div>
          ) : null}
          {hasQualityLoadFailure ? (
            <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
              Some quality items couldn&apos;t be refreshed. Showing the latest results that are available.
            </div>
          ) : null}

          {isLoading ? (
            <div className="flex min-h-48 items-center justify-center">
              <LogoSpinner imageClassName="h-7 w-7" />
            </div>
          ) : showEmptyState ? (
            <div className="rounded-lg border border-dashed border-border p-6">
              <p className="text-sm font-medium text-foreground">You&apos;re caught up</p>
              <p className="mt-1 text-sm text-muted-foreground">
                New handoffs, approvals, and answer problems will appear here.
              </p>
              <Button asChild size="sm" variant="outline" className="mt-4">
                <Link href={qualityOverflowHref}>View quality</Link>
              </Button>
            </div>
          ) : items.length > 0 ? (
            <>
              <DashboardTable
                aria-label="Needs attention"
                minWidth="min-w-[900px]"
                className="hidden md:block"
              >
                <DashboardTableHead>
                  <DashboardTableHeader className="w-32">Type</DashboardTableHeader>
                  <DashboardTableHeader>Item</DashboardTableHeader>
                  <DashboardTableHeader className="w-48">Detail</DashboardTableHeader>
                  <DashboardTableHeader className="w-40">Time</DashboardTableHeader>
                  <DashboardTableHeader className="w-32">
                    <span className="sr-only">Actions</span>
                  </DashboardTableHeader>
                </DashboardTableHead>
                <DashboardTableBody>
                  {items.map((item) => (
                    <InboxRow
                      key={item.key}
                      item={item}
                      now={now}
                      onReview={handleReviewItem}
                      onTriage={requestCloseReview}
                      isTriaging={item.assistantMessageId
                        ? triagingMessageIds.has(item.assistantMessageId)
                        : false}
                      reviewButtonRef={(node) =>
                        registerReviewButton(item.key, 'desktop', node)}
                    />
                  ))}
                </DashboardTableBody>
              </DashboardTable>
              <div
                className="overflow-hidden rounded-lg border border-border bg-card md:hidden"
                aria-label="Needs attention"
              >
                {items.map((item) => (
                  <MobileInboxRow
                    key={item.key}
                    item={item}
                    now={now}
                    onReview={handleReviewItem}
                    onTriage={requestCloseReview}
                    isTriaging={item.assistantMessageId
                      ? triagingMessageIds.has(item.assistantMessageId)
                      : false}
                    reviewButtonRef={(node) =>
                      registerReviewButton(item.key, 'mobile', node)}
                  />
                ))}
              </div>
            </>
          ) : null}

          {hasMoreQualityItems ? (
            <p className="text-sm text-muted-foreground">
              More quality items are available in{' '}
              <Link
                href={qualityOverflowHref}
                className="font-medium text-foreground underline underline-offset-4"
              >
                Quality
              </Link>
              .
            </p>
          ) : null}
        </div>
      </DashboardPage>

      <ConversationDrawer
        selectedItem={selectedHistoryItem}
        onSelectedItemChange={handleSelectedItemChange}
        anchorMessageId={selectedInboxItem?.assistantMessageId ?? routeState.historyMessageId}
        accessory={selectedFeedbackItem ? (
          <NegativeFeedbackAccessory
            key={selectedFeedbackItem.assistantMessageId}
            item={selectedFeedbackItem}
            knowledgeHref={knowledgeHref}
            behaviorHref={behaviorHref}
            agentChatHref={agentChatHref}
            isTriaging={selectedFeedbackItem.assistantMessageId
              ? triagingMessageIds.has(selectedFeedbackItem.assistantMessageId)
              : false}
            copyStatus={copyStatus}
            acknowledgementPending={
              acknowledgingMessageId === selectedFeedbackItem.assistantMessageId
            }
            acknowledgementError={acknowledgementError}
            triageError={triageError}
            onCopyQuestion={() => void handleCopyQuestion()}
            onResolve={(anchor) =>
              requestCloseReview(selectedFeedbackItem, 'resolved', anchor)}
            onDismiss={(anchor) =>
              requestCloseReview(selectedFeedbackItem, 'dismissed', anchor)}
          />
        ) : null}
        onAfterClose={handleDrawerClosed}
        onOperatorChanged={refreshInbox}
        pendingDecisions={decisions}
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
