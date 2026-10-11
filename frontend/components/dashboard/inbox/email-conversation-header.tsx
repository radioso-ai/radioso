'use client'

import { useCallback, useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { useDashboardQueryPolicy } from '@/components/providers/dashboard-query-provider'
import { getApiErrorMessage } from '@/lib/api-error'
import { emailChannelApi, type ConversationEmailFacts } from '@/lib/api-email-channel'
import { dashboardQueryKeys } from '@/lib/dashboard-query-keys'
import { replyDeliveryLabel } from '@/lib/needs-attention-reply-review'
import { cn } from '@/lib/utils'

type EmailFactsState = {
  facts: ConversationEmailFacts | null
  error: string | null
  isLoading: boolean
}

type ReplyDelivery = NonNullable<ConversationEmailFacts['messages'][number]['delivery']>

// Facts that are still moving — a reply on its way, or sending not ready — are read again soon;
// settled facts only slowly, so a domain that stops verifying still reaches the composer.
const UNSETTLED_FACTS_POLL_MS = 5_000
const SETTLED_FACTS_POLL_MS = 30_000

const isReplyInFlight = (delivery: ReplyDelivery | null) =>
  delivery?.state === 'queued' || delivery?.state === 'accepted'

const factsPollMs = (facts: ConversationEmailFacts | undefined) =>
  facts && facts.sending.state === 'ok' && !facts.messages.some((message) => isReplyInFlight(message.delivery))
    ? SETTLED_FACTS_POLL_MS
    : UNSETTLED_FACTS_POLL_MS

/**
 * Reads an email conversation's sender, mailbox, subject, sending state and the delivery of each
 * reply; idle for any other conversation. `refresh` reads them again after an operator's own action
 * or a refused send; `readAt` changes with every successful read.
 */
export function useConversationEmailFacts(
  workspaceId: string,
  conversationId: string | null,
  isEmailConversation: boolean,
): EmailFactsState & { readAt: number; refresh: () => void } {
  const policy = useDashboardQueryPolicy()
  const queryClient = useQueryClient()
  const queryKey = useMemo(
    () => dashboardQueryKeys.conversations.emailFacts(workspaceId, conversationId ?? ''),
    [workspaceId, conversationId],
  )
  const isActive = isEmailConversation && conversationId !== null
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => emailChannelApi.getConversationFacts(conversationId ?? '', signal),
    enabled: isActive && policy.queriesEnabled,
    refetchInterval: (current) => factsPollMs(current.state.data),
  })

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey })
  }, [queryClient, queryKey])

  return {
    facts: isActive ? query.data ?? null : null,
    error: isActive && query.error ? getApiErrorMessage(query.error, 'Email details are unavailable.') : null,
    isLoading: isActive && query.data === undefined && !query.error,
    readAt: query.dataUpdatedAt,
    refresh,
  }
}

const participantLabel = (participant: ConversationEmailFacts['participant']) =>
  participant.displayName ? `${participant.displayName} <${participant.address}>` : participant.address

const isReplyFailure = (delivery: ReplyDelivery) =>
  delivery.state === 'bounced' || delivery.state === 'failed' || delivery.state === 'uncertain' || delivery.state === 'halted'

/**
 * The email envelope of a conversation — who wrote, to which mailbox, the latest subject — and
 * where each reply sent from it stands. `replyPreviews` names a reply by its text in the thread.
 */
export function EmailConversationHeader({
  facts,
  error,
  isLoading,
  replyPreviews,
}: EmailFactsState & { replyPreviews?: ReadonlyMap<string, string> }) {
  const replies = facts?.messages.flatMap((message) =>
    message.direction === 'outbound' && message.delivery ? [{ ...message, delivery: message.delivery }] : []) ?? []

  return (
    <section aria-label="Email" className="rounded-lg border border-border bg-muted/30 px-4 py-3 text-sm">
      {isLoading ? <p className="text-xs text-muted-foreground">Loading email details...</p> : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      {facts ? (
        <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1">
          <dt className="text-xs text-muted-foreground">From</dt>
          <dd className="min-w-0 truncate text-foreground">{participantLabel(facts.participant)}</dd>
          <dt className="text-xs text-muted-foreground">To</dt>
          <dd className="min-w-0 truncate text-foreground">{facts.mailbox.address}</dd>
          {facts.latest.cc.length > 0 ? (
            <>
              <dt className="text-xs text-muted-foreground">Cc</dt>
              <dd className="min-w-0 truncate text-foreground">{facts.latest.cc.join(', ')}</dd>
            </>
          ) : null}
          <dt className="text-xs text-muted-foreground">Subject</dt>
          <dd className="min-w-0 font-medium text-foreground">{facts.latest.subject ?? '(no subject)'}</dd>
        </dl>
      ) : null}
      {replies.length > 0 ? (
        <ul aria-label="Reply delivery" aria-live="polite" className="mt-2 space-y-1 border-t border-border pt-2">
          {replies.map((reply) => (
            <li key={reply.messageId} className="flex items-baseline gap-3 text-xs">
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                {replyPreviews?.get(reply.messageId) ?? reply.subject ?? 'Reply'}
              </span>
              <span className={cn('shrink-0 font-medium', isReplyFailure(reply.delivery) ? 'text-destructive' : 'text-foreground')}>
                {replyDeliveryLabel(reply.delivery.state, reply.delivery.failureCode)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}
