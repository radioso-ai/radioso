'use client'

import { useCallback, useMemo, type ReactNode } from 'react'
import { ExternalLink } from 'lucide-react'

import { ChatMessageThread } from '@/components/dashboard/chat-message-thread'
import { HistoryDocumentDialog } from '@/components/dashboard/history/history-document-dialog'
import {
  useHistoryDetailState,
  useHistoryDocumentDialogState,
} from '@/components/dashboard/history/use-chat-history-state'
import type { SelectedHistoryItem } from '@/components/dashboard/history/history-list'
import {
  ApprovalDecisionPanel,
  OperatorComposer,
  useOperatorActionRunner,
  type ChannelSendReadiness,
  type OperatorActionResult,
} from '@/components/dashboard/operator-composer'
import { Button } from '@/components/ui/button'
import { LogoSpinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useConversationActivity } from '@/hooks/use-conversation-activity'
import { useConversationTail } from '@/hooks/use-conversation-tail'
import { hitlApi } from '@/lib/api-hitl'
import { useOptionalAuth } from '@/lib/auth-context'
import type { ChatConversationSummary, PendingApprovalDecision } from '@/lib/api-types'
import { deriveConversationOutcome } from '@/lib/conversation-outcome'
import { emailSendUnavailableReason } from '@/lib/email-send-readiness'
import {
  doneControlTooltip,
  findFirstVisitorMessage,
  freshestOwnership,
  informativeChannelLabel,
  readOnlyHandledByLabel,
  resolveReadOnlySource,
  shouldShowDoneControl,
  stripTrackingParams,
  visitorIdentityLabel,
} from '@/lib/inbox-response'
import {
  deriveInboxResponseHandoffItem,
  findPendingApprovalDecision,
  inboxWaitingPresentation,
  type HandoffCandidateSource,
  type InboxItem,
} from '@/lib/needs-attention'
import { useSkillCatalog } from '@/lib/skill-catalog'
import { cn } from '@/lib/utils'
import { DeliveryFailurePanel } from './delivery-failure-panel'
import { EmailConversationHeader, useConversationEmailFacts } from './email-conversation-header'
import { HeldReplyPanel } from './held-reply-panel'
import { InboxReadOnlyFooter } from './inbox-readonly-footer'
import { InboxSituationCard } from './inbox-situation-card'
import { useConversationOperators } from './use-conversation-operators'

const noop = () => {}

/**
 * What the response view is showing. `item` is a Needs-you queue item — always
 * actionable, unchanged from before this view was shared with the All lens.
 * `readonly` is a conversation selected from the All lens's conversation log,
 * identified by `conversationId` alone — the same id-based loading the old
 * history drawer used, so a deep link resolves even when the conversation
 * isn't on the currently loaded list page. `conversation` is an optional,
 * best-effort hint (the row's own summary, when the selection came from a
 * visible row) that lets the header and actionable/read-only split render
 * immediately instead of waiting on the detail fetch; once `conversationDetail`
 * loads, its ownership takes over as the source of truth regardless.
 */
export type InboxResponseSelection =
  | { source: 'item'; item: InboxItem }
  | { source: 'readonly'; conversationId: string; conversation?: ChatConversationSummary }

interface InboxResponseViewProps {
  /** The workspace whose teammates Assign and Reassign offer. */
  workspaceId: string
  selection: InboxResponseSelection | null
  now: Date
  pendingDecisions: PendingApprovalDecision[]
  onOperatorChanged: (result: OperatorActionResult) => Promise<void> | void
  onRequestFeedbackClose: (item: InboxItem, anchor: HTMLElement) => void
  onOpenDebugView: (conversationId: string) => void
  /**
   * Fires when the selected conversation's detail fetch 404s (deleted, or
   * aged out by retention) — the same `onItemNotFound` seam
   * `useHistoryDetailState` already offers the builder drawer. A caller whose
   * selection is URL-addressable (the All lens's permalink-shaped deep link)
   * should use this to clear the dead id instead of leaving it live in the
   * URL for a refresh or re-share to walk straight back into.
   */
  onItemNotFound?: () => void
  /**
   * Scrolls the thread to this message once it loads (e.g. a Usage Details
   * "open message" deep link, or an Audience Pulse evidence handoff). Only
   * meaningful alongside a `readonly` selection; the Needs-you lens never
   * passes one.
   */
  anchorMessageId?: string | null
  /**
   * True when `anchorMessageId` came from an Audience Pulse evidence handoff —
   * lets the detail fetch fall back to the bounded evidence-anchor endpoint when
   * the cited question has scrolled out of the conversation's normal
   * recent-messages window (see `useHistoryDetailState`).
   */
  isAudiencePulseEvidence?: boolean
  /**
   * Rendered centered in this pane in place of the default "select an item"
   * prompt when nothing is selected. The Needs-you lens uses this to show its
   * confidence/empty-queue summary once the queue has zero open items —
   * "select an item from the queue" is not actionable advice when there's
   * nothing in the queue to select. The All lens uses it for the inverse
   * case: a selection that *was* made but 404'd (see `onItemNotFound`), so
   * the operator still sees why the pane is empty instead of a silent reset.
   */
  emptyPlaceholder?: ReactNode
}

/**
 * The right-hand pane of the two-pane inbox (spec 1116, FR-006..FR-012). Reuses
 * the same conversation-detail/tail data hooks the builder drawer uses (no new
 * realtime mechanism), and the composer/decision UI extracted into
 * `operator-composer.tsx` — this component owns only the response-view chrome:
 * header, situation card, and the type-specific Done control.
 */
export function InboxResponseView({
  workspaceId,
  selection,
  now,
  pendingDecisions,
  onOperatorChanged,
  onRequestFeedbackClose,
  onOpenDebugView,
  onItemNotFound,
  anchorMessageId = null,
  isAudiencePulseEvidence = false,
  emptyPlaceholder,
}: InboxResponseViewProps) {
  const item = selection?.source === 'item' ? selection.item : null
  const readOnlySelection = selection?.source === 'readonly' ? selection : null
  // The conversation id drives the detail fetch regardless of whether a row
  // summary was found — a deep link (a stale page, or arriving straight from
  // a URL) must still resolve, the same id-based loading the old history
  // drawer used (bug: previously this fell back to "select a conversation"
  // whenever the id wasn't on the currently loaded list page).
  const conversationId = item?.conversationId ?? readOnlySelection?.conversationId ?? null
  // Memoized on conversationId alone: useHistoryDetailState re-runs its fetch
  // whenever this object's reference changes, and this component re-renders
  // every second from the conversation tail poll below. An inline literal here
  // would recreate the object on each of those renders and re-trigger the
  // conversation-detail fetch in a tight loop, flashing the pane back to its
  // loading state and detaching whatever the operator is trying to click.
  const selectedItem: SelectedHistoryItem = useMemo(
    () => (conversationId ? { kind: 'chat', id: conversationId } : null),
    [conversationId],
  )

  const conversationTail = useConversationTail({
    conversationId: conversationId ?? '',
    enabled: conversationId !== null,
    intervalMs: 1000,
  })

  const {
    conversationDetail,
    isDetailLoading,
    detailError,
    refetchDetail,
    effectiveConversationMessages,
    selectedThreadMessageId,
    handleSelectThreadMessage,
  } = useHistoryDetailState({
    selectedItem,
    setSelectedItem: noop,
    onItemNotFound,
    additionalConversationMessages: conversationTail.messages,
    anchorMessageId,
    isAudiencePulseEvidence,
  })

  // The freshest ownership the pane has seen: the detail fetch loads once (then
  // only refreshes after an operator's own action), but the tail poll re-reads
  // ownership every second and is the only one of the two that observes a
  // transfer, take-over, or hand-back made elsewhere while this pane stays open. Every
  // ownership-derived action and label below — the composer, its "X is
  // handling this" state, Done's hand-back version, the situation card's
  // reason — reads this instead of `conversationDetail.ownership` directly.
  const effectiveOwnership = useMemo(
    () => freshestOwnership(conversationDetail?.ownership, conversationTail.ownership),
    [conversationDetail?.ownership, conversationTail.ownership],
  )
  // The conversation's activity from both reads: the tail poll sees an event recorded elsewhere —
  // a teammate's claim, reassignment, or hand-back — while this pane stays open.
  const activity = useConversationActivity({
    conversationId,
    detail: conversationDetail?.activity,
    poll: conversationTail.activity,
  })

  // The actionable/read-only split and the header's identity/waiting fields
  // prefer the independently-fetched conversation detail once it loads — see
  // `resolveReadOnlySource` for why (a page left open long enough for
  // ownership to change would otherwise keep rendering a stale hint's
  // actionable/read-only state).
  const readOnlySource: HandoffCandidateSource | null = useMemo(
    () => (readOnlySelection ? resolveReadOnlySource(readOnlySelection.conversation, conversationDetail) : null),
    [readOnlySelection, conversationDetail],
  )
  // A conversation selected from the All lens gets exactly the same actionable
  // treatment as a Needs-you queue item once it turns out to be live — awaiting
  // a human, human-owned, or still in progress with the agent — same composer,
  // same Done control, by reusing the identical handoff mapping the queue
  // itself builds from. Only a completed conversation stays read-only.
  const derivedHandoffItem = useMemo(
    () => (readOnlySource ? deriveInboxResponseHandoffItem(readOnlySource, now) : null),
    [readOnlySource, now],
  )
  const effectiveItem = item ?? derivedHandoffItem
  const currentUserId = useOptionalAuth()?.user?.userId ?? null
  const teammates = useConversationOperators(workspaceId, effectiveItem !== null)

  const {
    isDocumentDialogOpen,
    isDocumentLoading,
    documentDetail,
    documentError,
    handleOpenCitation,
    handleDocumentDialogOpenChange,
  } = useHistoryDocumentDialogState()

  const skillCatalog = useSkillCatalog(conversationId)
  const isEmailConversation = conversationDetail?.channelContext?.provider === 'email'
  const emailFacts = useConversationEmailFacts(workspaceId, conversationId, isEmailConversation)
  const refreshEmailFacts = emailFacts.refresh

  // Every operator action can change what the email header shows: a reply starts a delivery, an
  // acknowledgement clears a failure.
  const handleChanged = useCallback(async (result: OperatorActionResult) => {
    refreshEmailFacts()
    await Promise.all([refetchDetail(), onOperatorChanged(result)])
  }, [onOperatorChanged, refetchDetail, refreshEmailFacts])

  const handBackRunner = useOperatorActionRunner(conversationId ?? '', handleChanged)

  const handleDone = useCallback((anchor: HTMLElement) => {
    if (!effectiveItem) {
      return
    }
    if (effectiveItem.type === 'handoff') {
      const targetConversationId = effectiveItem.conversationId
      const version = effectiveOwnership?.version ?? null
      void handBackRunner.run('done', async () => {
        if (version === null) {
          throw new Error('Missing conversation ownership version.')
        }
        const response = await hitlApi.handBackConversation(targetConversationId, { expectedVersion: version })
        return { kind: 'ownership', conversationId: targetConversationId, ownershipState: response.ownership.state }
      })
      return
    }
    if (effectiveItem.type === 'negative_feedback') {
      onRequestFeedbackClose(effectiveItem, anchor)
    }
  }, [effectiveItem, effectiveOwnership, handBackRunner, onRequestFeedbackClose])

  // See `shouldShowDoneControl` for the visibility rule (only renders when
  // there's something to wrap up). `conversationDetail`'s own truthiness still
  // gates "not loaded yet" (see that helper); the ownership value it reads is
  // the freshest one once loaded.
  const showDoneControl = shouldShowDoneControl(
    effectiveItem?.type,
    conversationDetail ? { ownership: effectiveOwnership } : null,
    currentUserId,
  )
  // A handoff selected from the All lens can render its composer immediately
  // from the row's own summary (see `readOnlySource` above), before
  // `conversationDetail` — the actual source of both the ownership check
  // above and the hand-back version below — has loaded. Disabling Done until
  // then avoids a fast click hitting the "missing ownership version" error
  // for a state that merely hasn't loaded yet.
  const isDoneVersionPending = effectiveItem?.type === 'handoff' && !conversationDetail

  // Matched by identity (agentId + handle), not conversation — two pending
  // approvals can exist on one conversation, and matching by conversationId
  // alone would resolve whichever decision the list happened to return first.
  const approvalDecision = useMemo(
    () => (effectiveItem ? findPendingApprovalDecision(effectiveItem, pendingDecisions) : null),
    [effectiveItem, pendingDecisions],
  )

  const renderedMessages = effectiveConversationMessages.map((message) =>
    message.role === 'assistant' ? { ...message, persistedAssistantMessageId: message.id } : message)
  // An email reply waits for a successful read of its mailbox that says it can send: unknown or
  // stale facts never offer Send. A refused send reads the mailbox again.
  const sendUnavailableReason = isEmailConversation ? emailSendUnavailableReason(emailFacts) : null
  const sendReadiness: ChannelSendReadiness | undefined = isEmailConversation
    ? { unavailableReason: sendUnavailableReason, readAt: emailFacts.readAt, reread: refreshEmailFacts }
    : undefined
  // A resend goes out through the conversation's channel, so it waits for the same readiness a reply
  // does, and for the channel to be known at all.
  const resendUnavailableReason = conversationDetail ? sendUnavailableReason : 'Checking whether this conversation can send.'
  const replyPreviews = useMemo(
    () => new Map(isEmailConversation ? effectiveConversationMessages.map((message) => [message.id, message.content]) : []),
    [effectiveConversationMessages, isEmailConversation],
  )

  if (!selection) {
    return (
      <section className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground" aria-label="Response">
        {emptyPlaceholder ?? 'Select an item from the queue to respond.'}
      </section>
    )
  }

  // A read-only conversation that turned out to be live (awaiting a human,
  // human-owned, or still in progress) is actionable via `derivedHandoffItem`
  // (folded into `effectiveItem` above); this is only reached once the row's
  // own outcome rules it out, i.e. it's completed.
  const readOnlyOutcome = readOnlySource && !effectiveItem
    ? deriveConversationOutcome(readOnlySource, now)
    : null

  const entryUrl = conversationDetail?.entryPageUrl ? stripTrackingParams(conversationDetail.entryPageUrl) : null
  const channelLabel = informativeChannelLabel(conversationDetail?.channelContext)
  // Only a genuine escalation has a wait to report — a live conversation still
  // with the agent (no ownership record, or an AI-owned one) has no "waiting
  // since" or "with them since" to show.
  const waiting = effectiveItem?.escalatedAt ? inboxWaitingPresentation(effectiveItem, now) : null
  // Who wrote in depends on the channel: until the conversation (or its row) says which, the
  // session reading claims nothing.
  const channelSource = conversationDetail ?? readOnlySelection?.conversation
  const identity = visitorIdentityLabel({
    channel: channelSource?.channelContext?.provider ?? null,
    anonymousSessionId: !channelSource
      ? undefined
      : effectiveItem ? effectiveItem.anonymousSessionId : readOnlySource?.anonymousSessionId,
  })

  return (
    <section className="flex min-w-0 flex-1 flex-col" aria-label="Response">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border px-6 py-3">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="font-medium text-foreground">{identity}</span>
          {channelLabel ? (
            <>
              <span className="text-muted-foreground" aria-hidden>·</span>
              <span className="text-xs text-muted-foreground">{channelLabel}</span>
            </>
          ) : null}
          {entryUrl ? (
            <>
              <span className="text-muted-foreground" aria-hidden>·</span>
              <a
                href={entryUrl}
                target="_blank"
                rel="noreferrer"
                className="max-w-xs truncate text-xs text-muted-foreground hover:text-foreground hover:underline"
              >
                {entryUrl}
              </a>
            </>
          ) : null}
          {waiting ? (
            <>
              <span className="text-muted-foreground" aria-hidden>·</span>
              <span
                className={cn(
                  'text-xs font-medium',
                  waiting.tone === 'destructive' ? 'text-destructive' : 'text-amber-700 dark:text-amber-300',
                )}
              >
                {waiting.label}
              </span>
            </>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => conversationId && onOpenDebugView(conversationId)}
          className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
        >
          Open in debug view
          <ExternalLink className="h-3 w-3" aria-hidden />
        </button>
      </header>

      {/* Outside the detail branch: an action re-reads the detail, and the panel must keep its
          outcome and focus through that reload. */}
      {effectiveItem?.type === 'delivery_failed' && effectiveItem.deliveryFailure ? (
        <div className="shrink-0 px-6 pt-4">
          <DeliveryFailurePanel
            failure={effectiveItem.deliveryFailure}
            resendUnavailableReason={resendUnavailableReason}
            onChanged={handleChanged}
          />
        </div>
      ) : null}
      {effectiveItem?.type === 'approval' && effectiveItem.heldReplyId ? (
        <div className="shrink-0 px-6 pt-4">
          <HeldReplyPanel
            key={effectiveItem.conversationId}
            workspaceId={workspaceId}
            conversationId={effectiveItem.conversationId}
            sendUnavailableReason={sendUnavailableReason}
            onChanged={handleChanged}
          />
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        {isDetailLoading && !conversationDetail ? (
          <div className="flex h-full items-center justify-center">
            <LogoSpinner imageClassName="h-6 w-6" />
          </div>
        ) : detailError ? (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
            {detailError}
          </div>
        ) : (
          <div className="space-y-4">
            {isEmailConversation ? (
              <EmailConversationHeader
                facts={emailFacts.facts}
                error={emailFacts.error}
                isLoading={emailFacts.isLoading}
                replyPreviews={replyPreviews}
              />
            ) : null}
            {effectiveItem ? (
              <InboxSituationCard
                handoffReason={effectiveOwnership?.reason ?? null}
                firstVisitorMessage={findFirstVisitorMessage(effectiveConversationMessages)}
              />
            ) : null}
            {effectiveItem?.type === 'approval' && !effectiveItem.heldReplyId ? (
              approvalDecision ? (
                <ApprovalDecisionPanel
                  conversationId={effectiveItem.conversationId}
                  decision={approvalDecision}
                  onChanged={handleChanged}
                />
              ) : (
                <p className="text-sm text-muted-foreground">
                  This approval was already resolved or is no longer available.
                </p>
              )
            ) : null}
            <ChatMessageThread
              messages={renderedMessages}
              onOpenDocument={handleOpenCitation}
              onMessageSelect={handleSelectThreadMessage}
              selectedMessageId={selectedThreadMessageId ?? undefined}
              conversationId={conversationId ?? undefined}
              analyticsSurface="dashboard"
              skillCatalog={skillCatalog}
              audience="operator"
              activity={activity}
              hasOlderMessages={conversationDetail?.hasOlderMessages ?? false}
            />
          </div>
        )}
      </div>

      {effectiveItem ? (
        <OperatorComposer
          conversationId={effectiveItem.conversationId}
          ownership={effectiveOwnership}
          currentUserId={currentUserId}
          teammates={teammates.operators}
          onTeammatesStale={teammates.refresh}
          onChanged={handleChanged}
          externalError={handBackRunner.error}
          sendReadiness={sendReadiness}
          trailingActions={showDoneControl ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={handBackRunner.isBusy || isDoneVersionPending}
                  onClick={(event) => handleDone(event.currentTarget)}
                >
                  Done
                </Button>
              </TooltipTrigger>
              <TooltipContent>{doneControlTooltip(effectiveItem)}</TooltipContent>
            </Tooltip>
          ) : null}
        />
      ) : readOnlyOutcome ? (
        <InboxReadOnlyFooter
          outcome={readOnlyOutcome}
          handledByLabel={readOnlySource ? readOnlyHandledByLabel(readOnlySource) : null}
        />
      ) : null}

      <HistoryDocumentDialog
        open={isDocumentDialogOpen}
        isLoading={isDocumentLoading}
        error={documentError}
        document={documentDetail}
        onOpenChange={handleDocumentDialogOpenChange}
      />
    </section>
  )
}
