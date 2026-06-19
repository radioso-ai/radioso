'use client'

import { useMemo, useRef, useState } from 'react'
import { SendHorizonal } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { Textarea } from '@/components/ui/textarea'
import { hitlApi, isHitlApiStatusError } from '@/lib/api-hitl'
import type { ConversationOwnership, PendingApprovalDecision } from '@/lib/api-types'
import { deriveOperatorActions } from '@/lib/operator-actions'

interface OperatorActionBarProps {
  conversationId: string
  ownership?: ConversationOwnership
  pendingDecisions: PendingApprovalDecision[]
  onChanged: () => Promise<void> | void
}

const statusText = (status: ReturnType<typeof deriveOperatorActions>['status'], ownerLabel: string | null) => {
  if (status === 'awaiting_human') {
    return 'Waiting for a human'
  }

  if (status === 'human_owned') {
    return `Handled by ${ownerLabel ?? 'A teammate'}`
  }

  return 'AI is handling this'
}

const genericError = 'Something went wrong. Try again.'

export function OperatorActionBar({
  conversationId,
  ownership,
  pendingDecisions,
  onChanged,
}: OperatorActionBarProps) {
  const actions = useMemo(() => deriveOperatorActions(ownership), [ownership])
  const [message, setMessage] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const inFlightRef = useRef(false)

  const isBusy = busyAction !== null
  const trimmedMessage = message.trim()
  const hasVersion = actions.version !== null

  const runAction = async (actionId: string, callback: () => Promise<void>) => {
    if (inFlightRef.current) {
      return
    }

    inFlightRef.current = true
    setBusyAction(actionId)
    setError(null)

    try {
      await callback()
      await onChanged()
    } catch (caught) {
      if (isHitlApiStatusError(caught, 409)) {
        setError('This conversation changed - refreshing.')
        await onChanged()
        return
      }

      setError(genericError)
    } finally {
      inFlightRef.current = false
      setBusyAction(null)
    }
  }

  const handleTakeOver = () =>
    runAction('takeover', async () => {
      await hitlApi.takeOverConversation(conversationId, {})
    })

  const handleReply = () =>
    runAction('reply', async () => {
      if (actions.version === null) {
        throw new Error('Missing conversation ownership version.')
      }

      await hitlApi.replyAsHuman(conversationId, {
        message: trimmedMessage,
        expectedVersion: actions.version,
      })
      setMessage('')
    })

  const handleHandBack = () =>
    runAction('handback', async () => {
      if (actions.version === null) {
        throw new Error('Missing conversation ownership version.')
      }

      await hitlApi.handBackConversation(conversationId, {
        expectedVersion: actions.version,
      })
    })

  const handleResolveDecision = (
    decision: PendingApprovalDecision,
    optionId: string,
  ) =>
    runAction(`decision:${decision.handle}:${optionId}`, async () => {
      try {
        await hitlApi.resolveDecision(decision.agentId, decision.handle, {
          optionId,
          contentHash: decision.contentHash,
        })
      } catch (caught) {
        if (isHitlApiStatusError(caught, 422)) {
          setError('That option is no longer valid - refreshing.')
          return
        }

        throw caught
      }
    })

  return (
    <div className="sticky bottom-0 z-10 border-t border-border bg-background/95 p-4 shadow-[0_-8px_24px_rgba(15,23,42,0.06)] backdrop-blur">
      <div className="mx-auto max-w-3xl space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-medium text-foreground">
            {statusText(actions.status, actions.ownerLabel)}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {actions.canTakeOver ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={isBusy}
                onClick={() => void handleTakeOver()}
              >
                Take over
              </Button>
            ) : null}
            {actions.canHandBack ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={isBusy || !hasVersion}
                onClick={() => void handleHandBack()}
              >
                Hand back to AI
              </Button>
            ) : null}
          </div>
        </div>

        {actions.canReply ? (
          <div className="space-y-2">
            <Textarea
              aria-label="Human reply"
              placeholder="Write a human reply..."
              value={message}
              disabled={isBusy}
              onChange={(event) => setMessage(event.target.value)}
              className="min-h-20 resize-none"
            />
            <div className="flex justify-end">
              <Button
                type="button"
                size="sm"
                className="gap-1.5"
                disabled={isBusy || trimmedMessage.length === 0 || !hasVersion}
                onClick={() => void handleReply()}
              >
                <SendHorizonal className="h-3.5 w-3.5" aria-hidden />
                Send reply
              </Button>
            </div>
          </div>
        ) : null}

        {pendingDecisions.length > 0 ? (
          <>
            <Separator />
            <div className="space-y-2">
              {pendingDecisions.map((decision) => (
                <Card key={`${decision.agentId}:${decision.handle}`} className="gap-3 rounded-lg py-3 shadow-none">
                  <CardContent className="space-y-3 px-3">
                    <p className="text-sm text-foreground">
                      {decision.reason ?? 'Approval requested'}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {decision.options.map((option) => (
                        <Button
                          key={option.id}
                          type="button"
                          size="sm"
                          variant="secondary"
                          disabled={isBusy}
                          onClick={() => void handleResolveDecision(decision, option.id)}
                        >
                          {option.label}
                        </Button>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </>
        ) : null}

        {error ? (
          <p className="text-sm text-destructive" role="status">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  )
}
