'use client'

import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import { Send } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { hitlApi, isHitlApiStatusError } from '@/lib/api-hitl'
import type { ConversationOwnership, PendingApprovalDecision } from '@/lib/api-types'
import { deriveOperatorActions } from '@/lib/operator-actions'
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
        setError(genericError)
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

export interface OperatorComposerProps {
  conversationId: string
  ownership: ConversationOwnership | undefined
  onChanged: (result: OperatorActionResult) => Promise<void> | void
  disabled?: boolean
  /**
   * Rendered at the end of the composer's button row, after Send. The response
   * view uses this slot for its type-specific Done control so Send and Done
   * read as one row without this component knowing anything about Done's
   * per-item-type semantics.
   */
  trailingActions?: ReactNode
}

/**
 * The always-visible reply composer (FR-009). Sending implicitly claims the
 * conversation: an AI-owned conversation is taken over first, then the reply is
 * sent against the fresh ownership version — there is no separate take-over
 * step or button on this surface. A 409/422 on send surfaces as a conflict
 * message while preserving the drafted text (FR-012); only a successful send
 * clears the textarea.
 */
export function OperatorComposer({
  conversationId,
  ownership,
  onChanged,
  disabled,
  trailingActions,
}: OperatorComposerProps) {
  const [message, setMessage] = useState('')
  const actions = useMemo(() => deriveOperatorActions(ownership), [ownership])
  const runner = useOperatorActionRunner(conversationId, onChanged)
  const trimmedMessage = message.trim()
  const isDisabled = disabled || runner.isBusy

  const handleSend = useCallback(() => {
    if (trimmedMessage.length === 0) {
      return
    }
    void runner.run('send', async () => {
      let version = actions.version
      // Claims the conversation as part of sending whenever it isn't already
      // claimed by a specific human - both AI-owned and an unclaimed handoff
      // ("awaiting a human") are still take-over-able (FR-009).
      if (actions.canTakeOver) {
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
  }, [actions.canTakeOver, actions.version, conversationId, runner, trimmedMessage])

  return (
    <div
      className={cn(
        'flex shrink-0 flex-col gap-2 border-t border-border bg-background px-6 pt-4',
        // The global "Ask Ray" tag is fixed to the bottom-right viewport corner
        // (see AskRayTag in copilot-panel.tsx) and must stay exactly there. When
        // this composer renders a trailing action (Done), that button lands in
        // the same bottom-right corner, so give the row extra clearance below it
        // — sized to the tag's height, not its width, since the tag's single
        // line of text keeps a stable height across locales while its width
        // does not.
        trailingActions ? 'pb-12' : 'pb-4',
      )}
    >
      <Textarea
        aria-label="Reply to the visitor"
        placeholder="Reply to the visitor - sending takes over the conversation"
        value={message}
        disabled={isDisabled}
        onChange={(event) => setMessage(event.target.value)}
        className="min-h-16 resize-y"
      />
      {runner.error ? (
        <p className="text-xs text-destructive" role="status" aria-live="polite">
          {runner.error}
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
        <span className="flex-1" />
        {trailingActions}
      </div>
    </div>
  )
}

export interface ApprovalDecisionPanelProps {
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
