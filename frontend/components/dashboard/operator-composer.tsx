'use client'

import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, Send } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Textarea } from '@/components/ui/textarea'
import { hitlApi, isHitlApiStatusError, transferFailureCause } from '@/lib/api-hitl'
import type { ConversationOperator, ConversationOwnership, PendingApprovalDecision } from '@/lib/api-types'
import { deriveOperatorActions, ownershipMenu } from '@/lib/operator-actions'
import { cn } from '@/lib/utils'

/**
 * The operator-mutation outcomes a caller may need to react to (refetch a
 * conversation, drop a resolved approval from a list, show a conflict). Moved
 * here from the retired `operator-action-bar.tsx` — this module is the only
 * place that produces these results now that the drawer is builder-only
 * (spec 1116, User Story 4).
 */
export type OperatorActionResult =
  | { kind: 'ownership'; conversationId: string; ownershipState: ConversationOwnership['state'] }
  | { kind: 'reply'; conversationId: string }
  | { kind: 'decision_resolved'; agentId: string; handle: string }
  | { kind: 'refresh'; conversationId: string; reason: 'conflict' | 'invalid_option' }

const genericError = 'Something went wrong. Try again.'

/** A failure the caller can explain: its message, and what to re-read because of it. */
interface ExplainedFailure {
  message: string
  followUp?: () => void
}
const NO_TEAMMATES: readonly ConversationOperator[] = []

/**
 * Shared busy/single-flight/conflict handling for the three operator mutations
 * that live on the response view (reply, hand back, decision resolve). Each
 * caller supplies its own async action; this hook classifies the two
 * ownership-race error shapes (409 stale version, 422 stale decision option)
 * into a caller-visible message and a `refresh` result, otherwise a generic
 * failure message. Extracted from the original `OperatorActionBar`'s
 * `runAction` so the three consumers don't each reimplement conflict
 * detection.
 *
 * Exported so the response view's handoff Done control (hand back to the
 * agent — the fourth operator mutation, not itself part of the reply/decision
 * UI extracted from `OperatorActionBar`) can reuse the same conflict handling
 * instead of a fourth copy of it.
 */
export function useOperatorActionRunner(
  conversationId: string,
  onChanged: (result: OperatorActionResult) => Promise<void> | void,
) {
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const inFlightRef = useRef(false)

  const run = useCallback(async (
    actionId: string,
    callback: () => Promise<OperatorActionResult>,
    // Explains a failure the caller understands (a transfer's target or conversation gone)
    // instead of the generic message; null falls through to it.
    explainFailure?: (caught: unknown) => ExplainedFailure | null,
  ) => {
    if (inFlightRef.current) {
      return
    }
    inFlightRef.current = true
    setBusyAction(actionId)
    setError(null)

    try {
      await onChanged(await callback())
    } catch (caught) {
      if (isHitlApiStatusError(caught, 409) || isHitlApiStatusError(caught, 422)) {
        const invalidOption = isHitlApiStatusError(caught, 422)
        setError(invalidOption ? 'That option is no longer valid - refreshing.' : 'This conversation changed - refreshing.')
        await onChanged({ kind: 'refresh', conversationId, reason: invalidOption ? 'invalid_option' : 'conflict' })
      } else {
        const explained = explainFailure?.(caught) ?? null
        setError(explained?.message ?? genericError)
        explained?.followUp?.()
      }
    } finally {
      inFlightRef.current = false
      setBusyAction(null)
    }
  }, [conversationId, onChanged])

  return {
    busyAction,
    isBusy: busyAction !== null,
    error,
    clearError: () => setError(null),
    run,
  }
}

interface OperatorComposerProps {
  conversationId: string
  ownership: ConversationOwnership | undefined
  /** The signed-in teammate, compared to the ownership's user to tell "mine" from a teammate's. */
  currentUserId: string | null
  /** Teammates who can own the conversation, offered by Assign and Reassign. */
  teammates?: readonly ConversationOperator[]
  /** Re-reads the teammates when a transfer finds its target no longer eligible (not when the conversation is gone). */
  onTeammatesStale?: () => void
  onChanged: (result: OperatorActionResult) => Promise<void> | void
  disabled?: boolean
  /**
   * Rendered at the end of the composer's button row, after Send. The response
   * view uses this slot for its type-specific Done control so Send and Done
   * read as one row without this component knowing anything about Done's
   * per-item-type semantics.
   */
  trailingActions?: ReactNode
  /**
   * An error from a mutation run outside this composer's own send runner —
   * today, the response view's Done control (hand-back), which runs through
   * its own `useOperatorActionRunner` since Done's semantics vary by item
   * type. Surfaced through this composer's one visible error slot rather than
   * a second error area, so Send and Done never disagree about where an
   * operator looks for what went wrong. Falls back behind the composer's own
   * send error when both are set.
   */
  externalError?: string | null
}

/**
 * The reply composer (FR-009). Sending implicitly claims a conversation that
 * is AI-owned or waiting unclaimed: it is taken over first, then the reply is
 * sent against the fresh ownership version. A conversation a teammate holds
 * shows who is handling it and Reassign instead of the composer, so two people
 * never reply blind; Reassign → Me brings the composer back. Assign (nobody
 * holds it) and Reassign (I or a teammate hold it) both transfer the
 * conversation to the chosen teammate. Until the signed-in teammate is known,
 * nothing that depends on who holds the conversation shows: no handling line,
 * no Assign/Reassign, and no composer on a held conversation; one nobody holds
 * keeps its claim-on-send composer, since the server claims it for whoever is
 * signed in. A 409/422 surfaces as a conflict message while preserving the
 * drafted text (FR-012) — the draft lives here, not in the textarea, so it
 * survives the composer being swapped for the handling line; only a
 * successful send clears it.
 */
export function OperatorComposer({
  conversationId,
  ownership,
  currentUserId,
  teammates = NO_TEAMMATES,
  onTeammatesStale,
  onChanged,
  disabled,
  trailingActions,
  externalError,
}: OperatorComposerProps) {
  const [message, setMessage] = useState('')
  const actions = useMemo(() => deriveOperatorActions(ownership, currentUserId), [ownership, currentUserId])
  const menu = useMemo(
    () => ownershipMenu(actions, teammates, currentUserId),
    [actions, currentUserId, teammates],
  )
  const runner = useOperatorActionRunner(conversationId, onChanged)
  const trimmedMessage = message.trim()
  const isDisabled = disabled || runner.isBusy
  const visibleError = runner.error ?? externalError ?? null

  const transferTo = useCallback((target: { kind: 'me' | 'teammate'; userId: string }) => {
    const toUserId = target.userId
    void runner.run('transfer', async () => {
      if (actions.version === null) {
        throw new Error('Missing conversation ownership version.')
      }
      const response = await hitlApi.transferConversation(conversationId, { toUserId, expectedVersion: actions.version })
      return { kind: 'ownership', conversationId, ownershipState: response.ownership.state }
    }, (caught) => {
      switch (transferFailureCause(caught)) {
        case 'target_unavailable':
          return {
            message: target.kind === 'me' ? 'You can no longer take this.' : 'That teammate can no longer take this.',
            followUp: onTeammatesStale,
          }
        case 'conversation_missing':
          return { message: 'This conversation is no longer available.' }
        default:
          return null
      }
    })
  }, [actions.version, conversationId, onTeammatesStale, runner])

  const handleSend = useCallback(() => {
    if (trimmedMessage.length === 0) {
      return
    }
    void runner.run('send', async () => {
      let version = actions.version
      // Claims the conversation as part of sending whenever nobody holds it -
      // both AI-owned and an unclaimed handoff ("awaiting a human") are still
      // take-over-able (FR-009).
      if (actions.claimsOnSend) {
        const takeover = await hitlApi.takeOverConversation(conversationId, {})
        version = takeover.ownership.version
      }
      if (version === null) {
        throw new Error('Missing conversation ownership version.')
      }
      await hitlApi.replyAsHuman(conversationId, { message: trimmedMessage, expectedVersion: version })
      setMessage('')
      return { kind: 'reply', conversationId }
    })
  }, [actions.claimsOnSend, actions.version, conversationId, runner, trimmedMessage])

  // The global "Ask Ray" tag is fixed to the bottom-right viewport corner
  // (see AskRayTag in copilot-panel.tsx) and must stay exactly there. When
  // this composer renders a trailing action (Done), that button lands in the
  // same bottom-right corner, so give the row extra clearance below it — sized
  // to the tag's height, not its width, since the tag's single line of text
  // keeps a stable height across locales while its width does not.
  const containerClassName = cn(
    'flex shrink-0 flex-col gap-2 border-t border-border bg-background px-6 pt-4',
    trailingActions ? 'pb-12' : 'pb-4',
  )

  const ownershipControl = menu ? (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant={actions.canReply ? 'ghost' : 'outline'}
          className="gap-1"
          disabled={isDisabled}
        >
          {menu.kind === 'assign' ? 'Assign' : 'Reassign'}
          <ChevronDown className="h-3.5 w-3.5" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {menu.targets.map((target) => (
          <DropdownMenuItem key={target.userId} onSelect={() => transferTo(target)}>
            {target.kind === 'me' ? 'Me' : target.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  ) : null

  // A teammate's conversation keeps the trailing actions: Done on a feedback
  // item is triage, not a reply, so it never waits on reassigning the conversation.
  // While the signed-in teammate is unknown, a held conversation shows only
  // those: naming its holder as "a teammate" could be telling me about myself.
  if (!actions.canReply) {
    return (
      <div className={containerClassName}>
        {visibleError ? (
          <p className="text-xs text-destructive" role="status" aria-live="polite">
            {visibleError}
          </p>
        ) : null}
        <div className="flex items-center gap-2 text-sm">
          {actions.status === 'owned_by_teammate' ? (
            <span className="text-muted-foreground">
              {actions.owner?.label ?? 'A teammate'} is handling this
            </span>
          ) : null}
          {ownershipControl ? (
            <>
              <span aria-hidden className="text-muted-foreground">·</span>
              {ownershipControl}
            </>
          ) : null}
          <span className="flex-1" />
          {trailingActions}
        </div>
      </div>
    )
  }

  return (
    <div className={containerClassName}>
      <Textarea
        aria-label="Reply to the visitor"
        placeholder="Reply to the visitor - sending takes over the conversation"
        value={message}
        disabled={isDisabled}
        onChange={(event) => setMessage(event.target.value)}
        className="min-h-16 resize-y"
      />
      {visibleError ? (
        <p className="text-xs text-destructive" role="status" aria-live="polite">
          {visibleError}
        </p>
      ) : null}
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          className="gap-1.5"
          disabled={isDisabled || trimmedMessage.length === 0}
          onClick={handleSend}
        >
          <Send className="h-3.5 w-3.5" aria-hidden />
          Send
        </Button>
        {ownershipControl}
        <span className="flex-1" />
        {trailingActions}
      </div>
    </div>
  )
}

interface ApprovalDecisionPanelProps {
  conversationId: string
  decision: PendingApprovalDecision
  onChanged: (result: OperatorActionResult) => Promise<void> | void
}

/**
 * The pending-approval decision buttons (FR-011), each carrying its author-
 * defined option description as a tooltip via the native `title` attribute —
 * moved verbatim from `OperatorActionBar`, just no longer tied to a reply bar.
 */
export function ApprovalDecisionPanel({ conversationId, decision, onChanged }: ApprovalDecisionPanelProps) {
  const runner = useOperatorActionRunner(conversationId, onChanged)

  const handleResolve = useCallback((optionId: string) => {
    void runner.run(`decision:${decision.handle}:${optionId}`, async () => {
      await hitlApi.resolveDecision(decision.agentId, decision.handle, {
        optionId,
        contentHash: decision.contentHash,
      })
      return { kind: 'decision_resolved', agentId: decision.agentId, handle: decision.handle }
    })
  }, [decision.agentId, decision.contentHash, decision.handle, runner])

  return (
    <div className="rounded-lg border border-border bg-muted/20 p-4" aria-label="Pending approval">
      <p className="text-sm text-foreground">{decision.reason ?? 'Approval requested'}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {decision.options.map((option) => (
          <Button
            key={option.id}
            type="button"
            size="sm"
            variant="secondary"
            disabled={runner.isBusy || !decision.canResolve}
            title={option.description ?? undefined}
            onClick={() => handleResolve(option.id)}
          >
            {option.label}
          </Button>
        ))}
      </div>
      {runner.error ? (
        <p className="mt-2 text-xs text-destructive" role="status" aria-live="polite">
          {runner.error}
        </p>
      ) : null}
    </div>
  )
}
