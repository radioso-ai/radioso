'use client'

import { useCallback, useEffect, useId, useRef, useState } from 'react'

import { useOperatorActionRunner, type OperatorActionResult } from '@/components/dashboard/operator-composer'
import { Button } from '@/components/ui/button'
import { getApiErrorCode, getApiErrorMessage } from '@/lib/api-error'
import { getHitlApiErrorStatus } from '@/lib/api-hitl'
import { replyReviewApi, type DeliveryFailure } from '@/lib/api-reply-review'
import { replyDeliveryLabel } from '@/lib/needs-attention-reply-review'

type Resolution = 'marked_sent' | 'resend'

const RESOLUTION_COPY: Record<Resolution, { action: string; consequence: string; outcome: string }> = {
  marked_sent: {
    action: 'Mark sent',
    consequence: 'Marks this reply as delivered without sending it.',
    outcome: 'Marked sent.',
  },
  resend: {
    action: 'Resend',
    consequence: 'Sends this reply again; the customer may receive it twice.',
    outcome: 'Queued to send again.',
  },
}

const MARK_SENT_UNAVAILABLE = 'Only an unconfirmed send can be marked sent.'

// A failure already cleared — by a teammate, a later delivered reply, or provider evidence — or gone
// is closed all the same: acknowledging it again has nothing left to do.
const isAlreadyClosed = (caught: unknown) =>
  getHitlApiErrorStatus(caught) === 404
  || (getHitlApiErrorStatus(caught) === 409 && getApiErrorCode(caught) === 'already_cleared')

// A resolution the server refuses for a reason it explains: the failure no longer admits it, or the
// channel cannot send yet.
const explainResolutionRefusal = (caught: unknown) => {
  const code = getApiErrorCode(caught)
  return getHitlApiErrorStatus(caught) === 409 && (code === 'not_resolvable' || code === 'email_sending_not_verified')
    ? { message: getApiErrorMessage(caught, 'This delivery failure cannot be resolved that way.') }
    : null
}

type FocusTarget = 'panel' | 'confirm' | Resolution

/**
 * A reply that may not have reached the customer. Acknowledging clears it from the Inbox. An
 * unconfirmed send can be marked sent, and an unconfirmed or halted one sent again once its channel
 * can send; both ask for one confirmation that states the consequence. Each action that does not
 * apply stays disabled with the reason. After a resolution the panel keeps focus and says what
 * happened.
 */
export function DeliveryFailurePanel({
  failure,
  resendUnavailableReason,
  onChanged,
}: {
  failure: DeliveryFailure
  /** Why the channel cannot send this reply again now; null once it can. */
  resendUnavailableReason: string | null
  onChanged: (result: OperatorActionResult) => Promise<void> | void
}) {
  const runner = useOperatorActionRunner(failure.conversationId, onChanged)
  const [confirming, setConfirming] = useState<{ failureId: string; resolution: Resolution } | null>(null)
  const [settled, setSettled] = useState<{ failureId: string; resolution: Resolution } | null>(null)
  const panelRef = useRef<HTMLElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const actionRefs = useRef<Partial<Record<Resolution, HTMLButtonElement | null>>>({})
  const focusAfterRender = useRef<FocusTarget | null>(null)
  const markSentReasonId = useId()
  const resendReasonId = useId()

  const pending = confirming?.failureId === failure.id ? confirming.resolution : null
  const outcome = settled?.failureId === failure.id ? settled.resolution : null
  const isResolvable = failure.kind === 'uncertain' || failure.kind === 'halted'
  const markSentReason = failure.kind === 'uncertain' ? null : MARK_SENT_UNAVAILABLE

  useEffect(() => {
    const target = focusAfterRender.current
    if (!target || runner.isBusy) return
    focusAfterRender.current = null
    if (target === 'panel') panelRef.current?.focus()
    else if (target === 'confirm') confirmRef.current?.focus()
    else actionRefs.current[target]?.focus()
  })

  const handleAcknowledge = useCallback(() => {
    void runner.run(`acknowledge:${failure.id}`, async () => {
      try {
        await replyReviewApi.acknowledgeDeliveryFailure(failure.id)
      } catch (caught) {
        if (!isAlreadyClosed(caught)) {
          throw caught
        }
      }
      return {
        kind: 'delivery_failure_cleared',
        conversationId: failure.conversationId,
        failureId: failure.id,
        resolution: 'acknowledged',
      }
    })
  }, [failure.conversationId, failure.id, runner])

  const askToConfirm = (resolution: Resolution) => {
    runner.clearError()
    setConfirming({ failureId: failure.id, resolution })
    focusAfterRender.current = 'confirm'
  }

  const cancelConfirmation = (resolution: Resolution) => {
    setConfirming(null)
    focusAfterRender.current = resolution
  }

  const handleResolve = (resolution: Resolution) => {
    void runner.run(`resolve:${failure.id}:${resolution}`, async () => {
      await replyReviewApi.resolveDeliveryFailure(failure.id, resolution)
      setConfirming(null)
      setSettled({ failureId: failure.id, resolution })
      focusAfterRender.current = 'panel'
      return { kind: 'delivery_failure_cleared', conversationId: failure.conversationId, failureId: failure.id, resolution }
    }, (caught) => {
      const explained = explainResolutionRefusal(caught)
      return explained
        ? {
            ...explained,
            followUp: () => {
              setConfirming(null)
              focusAfterRender.current = 'panel'
            },
          }
        : null
    })
  }

  return (
    <section
      ref={panelRef}
      tabIndex={-1}
      className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 outline-none"
      aria-label="Delivery failure"
    >
      <p className="text-sm font-medium text-destructive">{replyDeliveryLabel(failure.kind, failure.detailCode)}</p>
      <p className="mt-1 text-sm text-muted-foreground">The customer may not have this reply.</p>
      <p className="mt-2 text-sm text-foreground" role="status" aria-live="polite">
        {outcome ? RESOLUTION_COPY[outcome].outcome : ''}
      </p>
      {outcome ? null : pending ? (
        <div className="mt-3 space-y-2" role="group" aria-label={`Confirm ${RESOLUTION_COPY[pending].action}`}>
          <p className="text-sm text-foreground">{RESOLUTION_COPY[pending].consequence}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              ref={confirmRef}
              type="button"
              size="sm"
              disabled={runner.isBusy}
              onClick={() => handleResolve(pending)}
            >
              Confirm
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={runner.isBusy}
              onClick={() => cancelConfirmation(pending)}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="secondary" disabled={runner.isBusy} onClick={handleAcknowledge}>
              Acknowledge
            </Button>
            {isResolvable ? (
              <>
                <Button
                  ref={(element) => { actionRefs.current.marked_sent = element }}
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={runner.isBusy || markSentReason !== null}
                  aria-describedby={markSentReason ? markSentReasonId : undefined}
                  onClick={() => askToConfirm('marked_sent')}
                >
                  {RESOLUTION_COPY.marked_sent.action}
                </Button>
                <Button
                  ref={(element) => { actionRefs.current.resend = element }}
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={runner.isBusy || resendUnavailableReason !== null}
                  aria-describedby={resendUnavailableReason ? resendReasonId : undefined}
                  onClick={() => askToConfirm('resend')}
                >
                  {RESOLUTION_COPY.resend.action}
                </Button>
              </>
            ) : null}
          </div>
          {isResolvable && markSentReason ? (
            <p id={markSentReasonId} className="text-xs text-muted-foreground">{markSentReason}</p>
          ) : null}
          {isResolvable && resendUnavailableReason ? (
            <p id={resendReasonId} className="text-xs text-muted-foreground">{resendUnavailableReason}</p>
          ) : null}
        </div>
      )}
      {runner.error ? (
        <p className="mt-2 text-xs text-destructive" role="status" aria-live="polite">
          {runner.error}
        </p>
      ) : null}
    </section>
  )
}
