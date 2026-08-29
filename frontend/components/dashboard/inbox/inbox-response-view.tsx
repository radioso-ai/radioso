'use client'

import { useCallback, useMemo } from 'react'
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
import type { PendingApprovalDecision } from '@/lib/api-types'
import {
  doneControlTooltip,
  findFirstVisitorMessage,
  informativeChannelLabel,
  stripTrackingParams,
  visitorIdentityLabel,
} from '@/lib/inbox-response'
import { inboxWaitingPresentation, type InboxItem } from '@/lib/needs-attention'
import { useSkillCatalog } from '@/lib/skill-catalog'
import { cn } from '@/lib/utils'
import { InboxSituationCard } from './inbox-situation-card'

const noop = () => {}

export interface InboxResponseViewProps {
  item: InboxItem | null
  now: Date
  pendingDecisions: PendingApprovalDecision[]
  onOperatorChanged: (result: OperatorActionResult) => Promise<void> | void
  onRequestFeedbackClose: (item: InboxItem, anchor: HTMLElement) => void
  onOpenDebugView: (conversationId: string) => void
}

/**
 * The right-hand pane of the two-pane inbox (spec 1116, FR-006..FR-012). Reuses
 * the same conversation-detail/tail data hooks the builder drawer uses (no new
 * realtime mechanism), and the composer/decision UI extracted into
 * `operator-composer.tsx` — this component owns only the response-view chrome:
 * header, situation card, and the type-specific Done control.
 */
export function InboxResponseView({
  item,
  now,
  pendingDecisions,
  onOperatorChanged,
  onRequestFeedbackClose,
  onOpenDebugView,
}: InboxResponseViewProps) {
  const conversationId = item?.conversationId ?? null
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
  } = useHistoryDetailState({
    selectedItem,
    setSelectedItem: noop,
    additionalConversationMessages: conversationTail.messages,
  })

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
    if (!item) {
      return
    }
    if (item.type === 'handoff') {
      const version = conversationDetail?.ownership?.version ?? null
      void handBackRunner.run('done', async () => {
        if (version === null) {
          throw new Error('Missing conversation ownership version.')
        }
        const response = await hitlApi.handBackConversation(item.conversationId, { expectedVersion: version })
        return { kind: 'ownership', conversationId: item.conversationId, ownershipState: response.ownership.state }
      })
      return
    }
    if (item.type === 'negative_feedback') {
      onRequestFeedbackClose(item, anchor)
    }
  }, [conversationDetail, handBackRunner, item, onRequestFeedbackClose])

  const approvalDecision = useMemo(
    () => item?.type === 'approval'
      ? pendingDecisions.find((decision) => decision.conversationId === item.conversationId) ?? null
      : null,
    [item, pendingDecisions],
  )

  const renderedMessages = effectiveConversationMessages.map((message) =>
    message.role === 'assistant' ? { ...message, persistedAssistantMessageId: message.id } : message)

  if (!item) {
    return (
      <section className="flex flex-1 items-center justify-center text-sm text-muted-foreground" aria-label="Response">
        Select an item from the queue to respond.
      </section>
    )
  }

  const entryUrl = conversationDetail?.entryPageUrl ? stripTrackingParams(conversationDetail.entryPageUrl) : null
  const channelLabel = informativeChannelLabel(conversationDetail?.channelContext)
  const waiting = inboxWaitingPresentation(item, now)
  const identity = visitorIdentityLabel({ anonymousSessionId: item.anonymousSessionId })

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
          <span className="text-muted-foreground" aria-hidden>·</span>
          <span
            className={cn(
              'text-xs font-medium',
              waiting.tone === 'destructive' ? 'text-destructive' : 'text-amber-700 dark:text-amber-300',
            )}
          >
            {waiting.label}
          </span>
        </div>
        <button
          type="button"
          onClick={() => onOpenDebugView(item.conversationId)}
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
            <InboxSituationCard
              handoffReason={conversationDetail?.ownership?.reason ?? null}
              firstVisitorMessage={findFirstVisitorMessage(effectiveConversationMessages)}
            />
            {item.type === 'approval' ? (
              approvalDecision ? (
                <ApprovalDecisionPanel
                  conversationId={item.conversationId}
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
              conversationId={conversationId ?? undefined}
              analyticsSurface="dashboard"
              skillCatalog={skillCatalog}
            />
          </div>
        )}
      </div>

      <OperatorComposer
        conversationId={item.conversationId}
        ownership={conversationDetail?.ownership}
        onChanged={handleChanged}
        trailingActions={item.type !== 'approval' ? (
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
            <TooltipContent>{doneControlTooltip(item)}</TooltipContent>
          </Tooltip>
        ) : null}
      />

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
