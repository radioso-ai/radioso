'use client'

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ChevronDown } from 'lucide-react'

import { useOperatorActionRunner, type OperatorActionResult } from '@/components/dashboard/operator-composer'
import { isDashboardQueryRetryable, useDashboardQueryPolicy } from '@/components/providers/dashboard-query-provider'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Textarea } from '@/components/ui/textarea'
import { getApiErrorCode, getApiErrorMessage } from '@/lib/api-error'
import { getHitlApiErrorStatus } from '@/lib/api-hitl'
import { replyReviewApi, type HeldReply } from '@/lib/api-reply-review'
import { dashboardQueryKeys } from '@/lib/dashboard-query-keys'
import { heldReplyFactsLine, heldReplyHoldLine, heldReplyOutcomeLabel, heldReplyReasoningLines } from '@/lib/needs-attention-reply-review'

type OwnOutcome = 'released' | 'edited' | 'discarded'

const OWN_OUTCOME: Record<OwnOutcome, string> = {
  released: 'Sent.',
  edited: 'Sent your edit.',
  discarded: 'Discarded. It stays in your Inbox until someone replies.',
}

// A held reply someone else settled, or the server refused because it was settled.
const SETTLED_ELSEWHERE: Record<Exclude<HeldReply['state'], 'pending'>, string> = {
  released: 'Already released.',
  edited: 'Already released.',
  discarded: 'Already discarded.',
  superseded: 'Replaced. Nothing was sent.',
  queued_auto: 'Queued to send automatically.',
}

// The release refusals that leave the draft pending, by the server's error code.
const REFUSAL: Record<string, string> = {
  ownership_changed: 'This conversation changed hands. Nothing was sent.',
  policy_changed: 'The mailbox settings changed. Nothing was sent.',
  channel_not_ready: 'This mailbox can no longer send. Nothing was sent.',
}

// What restores sending, by the step an `email_sending_not_verified` refusal names.
const SENDING_STEP: Record<string, (domain: string | null) => string> = {
  verify_sending_domain: (domain) => `Verify ${domain ?? 'the sending domain'} in Settings, then send again.`,
  add_sending_domain: () => 'Add a sending domain in Settings, then send again.',
  add_mailbox: () => 'Add this mailbox again in Settings, then send again.',
}

const DISCARD_CONSEQUENCE = 'Nothing is sent. The conversation stays in your Inbox until someone replies.'
// The release contract's limit on an edited reply.
const MAX_REPLY_LENGTH = 20_000

const PENDING_POLL_MS = 5_000
const SETTLED_POLL_MS = 30_000

// A server without the held-reply route answers 404: that is no draft, not an outage to retry.
const retryCurrentHeldReply = (attempt: number, error: unknown) =>
  attempt < 2 && isDashboardQueryRetryable(error) && getHitlApiErrorStatus(error) !== 404

/** The `error.details` of an API error body, when it carries them. */
const refusalDetails = (caught: unknown): unknown =>
  caught && typeof caught === 'object' && 'error' in caught
    ? (caught.error as { details?: unknown } | null)?.details
    : undefined

const stringDetail = (details: unknown, key: string): string | null => {
  const value = details && typeof details === 'object' && key in details ? (details as Record<string, unknown>)[key] : null
  return typeof value === 'string' ? value : null
}

/** The held reply the server sent back with a `held_reply_not_pending` refusal, when it did. */
const heldReplyFromRefusal = (caught: unknown): HeldReply | null => {
  const details = refusalDetails(caught)
  const candidate = details && typeof details === 'object' && 'heldReply' in details ? details.heldReply : null
  return candidate && typeof candidate === 'object' && 'id' in candidate && 'state' in candidate
    ? candidate as HeldReply
    : null
}

/** Why a release left the draft pending, by the server's error code; null for any other error. */
const refusalMessage = (code: string | undefined, details: unknown): string | null => {
  if (code === 'email_sending_not_verified') {
    const step = stringDetail(details, 'step')
    const next = step && Object.hasOwn(SENDING_STEP, step) ? SENDING_STEP[step](stringDetail(details, 'domain')) : null
    return `Sending is not verified for this mailbox. ${next ?? 'Nothing was sent.'}`
  }
  return code && Object.hasOwn(REFUSAL, code) ? REFUSAL[code] : null
}

/**
 * Reads the conversation's current held reply while it is open, often while one waits for review,
 * so a newer draft or a teammate's release shows without a reload.
 */
function useCurrentHeldReply(workspaceId: string, conversationId: string) {
  const policy = useDashboardQueryPolicy()
  const queryKey = useMemo(
    () => dashboardQueryKeys.conversations.heldReply(workspaceId, conversationId),
    [workspaceId, conversationId],
  )
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => replyReviewApi.getCurrentHeldReply(conversationId, signal),
    enabled: policy.queriesEnabled,
    refetchInterval: (current) =>
      current.state.data?.heldReply?.state === 'pending' ? PENDING_POLL_MS : SETTLED_POLL_MS,
    retry: retryCurrentHeldReply,
  })
  return { query, queryKey }
}

type FocusTarget = 'panel' | 'confirm' | 'discard'

/**
 * A reply the agent wrote and an operator reviews before the customer gets it: the turn's outcome,
 * what it found, its reasoning, and whether it depends on an action that did not run. The operator
 * sends it as written, edits then sends it (the original is kept and shown), or discards it after
 * one confirmation. A newer draft replaces the one shown. After every action the panel keeps focus
 * and says what happened, including when a teammate got there first.
 */
export function HeldReplyPanel({
  workspaceId,
  conversationId,
  sendUnavailableReason,
  onChanged,
}: {
  workspaceId: string
  conversationId: string
  /** Why this conversation cannot send now; null once it can. */
  sendUnavailableReason: string | null
  onChanged: (result: OperatorActionResult) => Promise<void> | void
}) {
  const queryClient = useQueryClient()
  const { query, queryKey } = useCurrentHeldReply(workspaceId, conversationId)
  const runner = useOperatorActionRunner(conversationId, onChanged)
  // What this operator's own action, or the server's refusal, said about a held reply: fresher
  // than a poll that may have left before it.
  const [local, setLocal] = useState<HeldReply | null>(null)
  const [own, setOwn] = useState<{ id: string; outcome: OwnOutcome } | null>(null)
  const [edit, setEdit] = useState<{ id: string; text: string } | null>(null)
  const [confirmingDiscard, setConfirmingDiscard] = useState<string | null>(null)
  const [shown, setShown] = useState<{ id: string; pending: boolean } | null>(null)
  const [notice, setNotice] = useState('')
  const panelRef = useRef<HTMLElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const discardRef = useRef<HTMLButtonElement>(null)
  const focusAfterRender = useRef<FocusTarget | null>(null)
  const sendReasonId = useId()

  const server = query.data?.heldReply ?? null
  const heldReply = local && (!server || server.id === local.id) ? local : server

  // A different held reply than the one on show means a newer inbound replaced it.
  if (heldReply && (heldReply.id !== shown?.id || (heldReply.state === 'pending') !== shown.pending)) {
    if (shown && heldReply.id !== shown.id) {
      setNotice(shown.pending ? 'A newer message replaced the draft.' : 'A new draft is waiting.')
    }
    setShown({ id: heldReply.id, pending: heldReply.state === 'pending' })
  }

  useEffect(() => {
    const target = focusAfterRender.current
    if (!target || runner.isBusy) return
    focusAfterRender.current = null
    if (target === 'panel') panelRef.current?.focus()
    else if (target === 'confirm') confirmRef.current?.focus()
    else discardRef.current?.focus()
  })

  const settle = useCallback((settled: HeldReply, outcome: OwnOutcome | null) => {
    setLocal(settled)
    setOwn(outcome ? { id: settled.id, outcome } : null)
    setNotice('')
    setConfirmingDiscard(null)
    queryClient.setQueryData(queryKey, { heldReply: settled })
    focusAfterRender.current = 'panel'
  }, [queryClient, queryKey])

  const explainRefusal = useCallback((target: HeldReply) => (caught: unknown) => {
    const status = getHitlApiErrorStatus(caught)
    const code = getApiErrorCode(caught)
    const reportStale = () => {
      void queryClient.invalidateQueries({ queryKey })
      void onChanged({ kind: 'held_reply_settled', conversationId, heldReplyId: target.id, outcome: 'stale' })
    }
    if (status === 409 && code === 'held_reply_not_pending') {
      const current = heldReplyFromRefusal(caught)
      return {
        message: current ? null : 'This draft was already handled.',
        followUp: () => {
          if (current) settle(current, null)
          else focusAfterRender.current = 'panel'
          reportStale()
        },
      }
    }
    const refusal = status === 409 ? refusalMessage(code, refusalDetails(caught)) : null
    if (refusal) {
      return {
        message: refusal,
        followUp: () => {
          setConfirmingDiscard(null)
          focusAfterRender.current = 'panel'
          reportStale()
        },
      }
    }
    return null
  }, [conversationId, onChanged, queryClient, queryKey, settle])

  if (!heldReply) {
    return (
      <section
        ref={panelRef}
        tabIndex={-1}
        className="rounded-lg border border-border bg-muted/20 p-4 text-sm text-muted-foreground outline-none"
        aria-label="Draft reply"
      >
        {query.isLoading ? (
          <p role="status">Loading the draft…</p>
        ) : query.error && getHitlApiErrorStatus(query.error) !== 404 ? (
          <p role="alert" className="text-destructive">{getApiErrorMessage(query.error, 'The draft is unavailable.')}</p>
        ) : (
          <p>No draft is waiting.</p>
        )}
      </section>
    )
  }

  const isPending = heldReply.state === 'pending'
  const text = edit?.id === heldReply.id ? edit.text : heldReply.draftText
  const isEdited = text.trim() !== heldReply.draftText.trim()
  const factsLine = heldReplyFactsLine(heldReply.facts)
  const holdLine = heldReplyHoldLine(heldReply.holdReason)
  const suppressedSkills = heldReply.suppressedEffects.map((effect) => effect.skillName)
  const reasoning = heldReply.trace ? heldReplyReasoningLines(heldReply.trace) : []
  const status = own?.id === heldReply.id
    ? OWN_OUTCOME[own.outcome]
    : heldReply.state === 'pending' ? notice : SETTLED_ELSEWHERE[heldReply.state]

  const release = () => {
    const target = heldReply
    const editedText = isEdited ? text.trim() : undefined
    void runner.run(`release:${target.id}`, async () => {
      const result = await replyReviewApi.releaseHeldReply(conversationId, target.id, editedText)
      const outcome: OwnOutcome = editedText === undefined ? 'released' : 'edited'
      settle(result.heldReply, outcome)
      return { kind: 'held_reply_settled', conversationId, heldReplyId: target.id, outcome }
    }, explainRefusal(target))
  }

  const discard = () => {
    const target = heldReply
    void runner.run(`discard:${target.id}`, async () => {
      settle(await replyReviewApi.discardHeldReply(conversationId, target.id), 'discarded')
      return { kind: 'held_reply_settled', conversationId, heldReplyId: target.id, outcome: 'discarded' }
    }, explainRefusal(target))
  }

  const askToDiscard = () => {
    runner.clearError()
    setConfirmingDiscard(heldReply.id)
    focusAfterRender.current = 'confirm'
  }

  const cancelDiscard = () => {
    setConfirmingDiscard(null)
    focusAfterRender.current = 'discard'
  }

  return (
    <section
      ref={panelRef}
      tabIndex={-1}
      className="max-h-[50vh] overflow-y-auto rounded-lg border border-border bg-muted/20 p-4 outline-none"
      aria-label="Draft reply"
    >
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-medium text-foreground">Draft reply</p>
        <Badge variant="secondary">{heldReplyOutcomeLabel(heldReply.facts)}</Badge>
        {heldReply.dependsOnSuppressedAction ? (
          <Badge variant="outline" className="gap-1 border-amber-500/40 text-amber-700 dark:text-amber-300">
            <AlertTriangle className="h-3 w-3" aria-hidden />
            Depends on an action that did not run
          </Badge>
        ) : null}
      </div>
      {heldReply.dependsOnSuppressedAction && suppressedSkills.length > 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">Not run: {suppressedSkills.join(', ')}</p>
      ) : null}
      {factsLine ? <p className="mt-1 text-xs text-muted-foreground">{factsLine}</p> : null}
      {holdLine ? <p className="mt-1 text-xs text-muted-foreground">{holdLine}</p> : null}

      {reasoning.length > 0 ? (
        <Collapsible className="mt-2">
          <CollapsibleTrigger className="group inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            Reasoning
            <ChevronDown className="h-3 w-3 transition-transform group-data-[state=open]:rotate-180" aria-hidden />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul aria-label="Reasoning" className="mt-1 space-y-0.5 text-xs text-muted-foreground">
              {reasoning.map((line) => (
                <li key={line.label}>
                  <span className="text-foreground/80">{line.label}:</span>{' '}
                  <span className={line.label === 'Turn' ? 'font-mono' : undefined}>{line.value}</span>
                </li>
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      ) : null}

      <p className="mt-2 text-sm text-foreground" role="status" aria-live="polite">{status}</p>

      {isPending ? (
        <div className="mt-2 space-y-2">
          <Textarea
            aria-label="Draft reply text"
            value={text}
            rows={5}
            maxLength={MAX_REPLY_LENGTH}
            disabled={runner.isBusy}
            onChange={(event) => setEdit({ id: heldReply.id, text: event.target.value })}
          />
          {confirmingDiscard === heldReply.id ? (
            <div className="space-y-2" role="group" aria-label="Confirm Discard">
              <p className="text-sm text-foreground">{DISCARD_CONSEQUENCE}</p>
              <div className="flex flex-wrap gap-2">
                <Button ref={confirmRef} type="button" size="sm" disabled={runner.isBusy} onClick={discard}>
                  Confirm
                </Button>
                <Button type="button" size="sm" variant="ghost" disabled={runner.isBusy} onClick={cancelDiscard}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                disabled={runner.isBusy || sendUnavailableReason !== null || text.trim() === ''}
                aria-describedby={sendUnavailableReason ? sendReasonId : undefined}
                onClick={release}
              >
                {isEdited ? 'Send edited' : 'Send draft'}
              </Button>
              {isEdited ? (
                <Button type="button" size="sm" variant="ghost" disabled={runner.isBusy} onClick={() => setEdit(null)}>
                  Revert
                </Button>
              ) : null}
              <Button ref={discardRef} type="button" size="sm" variant="outline" disabled={runner.isBusy} onClick={askToDiscard}>
                Discard
              </Button>
            </div>
          )}
          {sendUnavailableReason ? (
            <p id={sendReasonId} className="text-xs text-muted-foreground">{sendUnavailableReason}</p>
          ) : null}
        </div>
      ) : (
        <div className="mt-2 space-y-2">
          <p className={heldReply.state === 'released' || heldReply.state === 'edited'
            ? 'whitespace-pre-wrap text-sm text-foreground'
            : 'whitespace-pre-wrap text-sm text-muted-foreground'}
          >
            {heldReply.state === 'edited' && heldReply.editedText !== null ? heldReply.editedText : heldReply.draftText}
          </p>
          {heldReply.state === 'edited' ? (
            <div role="group" aria-label="Original draft" className="rounded-md border border-border/70 p-2">
              <p className="text-xs font-medium text-muted-foreground">Original draft</p>
              <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{heldReply.draftText}</p>
            </div>
          ) : null}
        </div>
      )}

      {runner.error ? (
        <p className="mt-2 text-xs text-destructive" role="status" aria-live="polite">{runner.error}</p>
      ) : null}
    </section>
  )
}
