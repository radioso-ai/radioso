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
  type OperatorActionResult,
} from '@/components/dashboard/operator-composer'
import { Button } from '@/components/ui/button'
import { LogoSpinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useConversationTail } from '@/hooks/use-conversation-tail'
import { hitlApi } from '@/lib/api-hitl'
import type { ChatConversationSummary, PendingApprovalDecision } from '@/lib/api-types'
import { deriveConversationOutcome } from '@/lib/conversation-outcome'
import {
  doneControlTooltip,
  findFirstVisitorMessage,
  informativeChannelLabel,
  readOnlyHandledByLabel,
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
import { InboxReadOnlyFooter } from './inbox-readonly-footer'
import { InboxSituationCard } from './inbox-situation-card'

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

export interface InboxResponseViewProps {
  selection: InboxResponseSelection | null
  now: Date
  pendingDecisions: PendingApprovalDecision[]
  onOperatorChanged: (result: OperatorActionResult) => Promise<void> | void
  onRequestFeedbackClose: (item: InboxItem, anchor: HTMLElement) => void
  onOpenDebugView: (conversationId: string) => void
  /**
   * Scrolls the thread to this message once it loads (e.g. a Usage Details
   * "open message" deep link, or an Audience Pulse evidence handoff). Only
   * meaningful alongside a `readonly` selection; the Needs-you lens never
   * passes one.
   */
  anchorMessageId?: string | null
  /**
   * True when `anchorMessageId` came from an Audience Pulse evidence handoff —
   * narrows the loaded window to the anchor and its answer instead of the
   * conversation's normal recent-messages window (see `useHistoryDetailState`).
   */
  isAudiencePulseEvidence?: boolean
  /**
   * Rendered centered in this pane in place of the default "select an item"
   * prompt when nothing is selected. The Needs-you lens uses this to show its
   * confidence/empty-queue summary once the queue has zero open items —
   * "select an item from the queue" is not actionable advice when there's
   * nothing in the queue to select. The All lens never passes one, so its
   * "nothing selected" state is unchanged.
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
  selection,
  now,
  pendingDecisions,
  onOperatorChanged,
  onRequestFeedbackClose,
  onOpenDebugView,
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
    additionalConversationMessages: conversationTail.messages,
    anchorMessageId,
    isAudiencePulseEvidence,
  })

  // The actionable/read-only split and the header's identity/waiting fields
  // prefer the row's own summary (immediate, no fetch needed) but fall back to
  // the independently-fetched conversation detail once it loads — the only
  // source available for a conversation that wasn't on the loaded list page.
  // `anonymousSessionId` has no equivalent on the detail response, so that one
  // field stays unknown (a generic visitor label) in the fallback case rather
  // than guessing.
  const readOnlySource: HandoffCandidateSource | null = useMemo(() => {
    if (!readOnlySelection) {
      return null
    }
    if (readOnlySelection.conversation) {
      return readOnlySelection.conversation
    }
    if (!conversationDetail) {
      return null
    }
    return {
      id: conversationDetail.conversationId,
      ownership: conversationDetail.ownership,
      updatedAt: conversationDetail.updatedAt,
      agentId: conversationDetail.agentId,
      agentName: conversationDetail.agentName ?? null,
      agentInternalName: conversationDetail.agentInternalName ?? null,
    }
  }, [readOnlySelection, conversationDetail])
  // A conversation selected from the All lens gets exactly the same actionable
  // treatment as a Needs-you queue item once it turns out to be awaiting a
  // human — same composer, same waiting-time presentation, same Done control —
  // by reusing the identical handoff mapping the queue itself builds from.
  const derivedHandoffItem = useMemo(
    () => (readOnlySource ? deriveInboxResponseHandoffItem(readOnlySource) : null),
    [readOnlySource],
  )
  const effectiveItem = item ?? derivedHandoffItem

  const {
    isDocumentDialogOpen,
    isDocumentLoading,
    documentDetail,
    documentError,
    handleOpenCitation,
    handleDocumentDialogOpenChange,
  } = useHistoryDocumentDialogState()

  const skillCatalog = useSkillCatalog(conversationId)

  const handleChanged = useCallback(async (result: OperatorActionResult) => {
    await Promise.all([refetchDetail(), onOperatorChanged(result)])
  }, [onOperatorChanged, refetchDetail])

  const handBackRunner = useOperatorActionRunner(conversationId ?? '', handleChanged)

  const handleDone = useCallback((anchor: HTMLElement) => {
    if (!effectiveItem) {
      return
    }
    if (effectiveItem.type === 'handoff') {
      const targetConversationId = effectiveItem.conversationId
      const version = conversationDetail?.ownership?.version ?? null
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
  }, [conversationDetail, effectiveItem, handBackRunner, onRequestFeedbackClose])

  // Matched by identity (agentId + handle), not conversation — two pending
  // approvals can exist on one conversation, and matching by conversationId
  // alone would resolve whichever decision the list happened to return first.
  const approvalDecision = useMemo(
    () => (effectiveItem ? findPendingApprovalDecision(effectiveItem, pendingDecisions) : null),
    [effectiveItem, pendingDecisions],
  )

  const renderedMessages = effectiveConversationMessages.map((message) =>
    message.role === 'assistant' ? { ...message, persistedAssistantMessageId: message.id } : message)

  if (!selection) {
    return (
      <section className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground" aria-label="Response">
        {emptyPlaceholder ?? 'Select an item from the queue to respond.'}
      </section>
    )
  }

  // A read-only conversation that turned out to be awaiting a human is
  // actionable via `derivedHandoffItem` (folded into `effectiveItem` above);
  // this is only true once the row's own ownership rules it out.
  const readOnlyOutcome = readOnlySource && !effectiveItem
    ? deriveConversationOutcome(readOnlySource, now)
    : null

  const entryUrl = conversationDetail?.entryPageUrl ? stripTrackingParams(conversationDetail.entryPageUrl) : null
  const channelLabel = informativeChannelLabel(conversationDetail?.channelContext)
  const waiting = effectiveItem ? inboxWaitingPresentation(effectiveItem, now) : null
  const identity = visitorIdentityLabel({
    anonymousSessionId: effectiveItem ? effectiveItem.anonymousSessionId : readOnlySource?.anonymousSessionId,
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
            {effectiveItem ? (
              <InboxSituationCard
                handoffReason={conversationDetail?.ownership?.reason ?? null}
                firstVisitorMessage={findFirstVisitorMessage(effectiveConversationMessages)}
              />
            ) : null}
            {effectiveItem?.type === 'approval' ? (
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
            />
          </div>
        )}
      </div>

      {effectiveItem ? (
        <OperatorComposer
          conversationId={effectiveItem.conversationId}
          ownership={conversationDetail?.ownership}
          onChanged={handleChanged}
          externalError={handBackRunner.error}
          trailingActions={effectiveItem.type !== 'approval' ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={handBackRunner.isBusy}
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
