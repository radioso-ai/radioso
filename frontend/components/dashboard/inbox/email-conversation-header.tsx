'use client'

import { useEffect, useState } from 'react'

import { getApiErrorMessage } from '@/lib/api-error'
import { emailChannelApi, type ConversationEmailFacts } from '@/lib/api-email-channel'

type EmailFactsState = {
  facts: ConversationEmailFacts | null
  error: string | null
  isLoading: boolean
}

/** Reads an email conversation's sender, mailbox, subject and sending state; idle for any other conversation. */
export function useConversationEmailFacts(conversationId: string | null, isEmailConversation: boolean): EmailFactsState {
  const [loaded, setLoaded] = useState<{ conversationId: string; facts: ConversationEmailFacts | null; error: string | null } | null>(null)

  useEffect(() => {
    if (!conversationId || !isEmailConversation) return
    let active = true
    emailChannelApi.getConversationFacts(conversationId).then(
      (facts) => { if (active) setLoaded({ conversationId, facts, error: null }) },
      (error: unknown) => {
        if (active) setLoaded({ conversationId, facts: null, error: getApiErrorMessage(error, 'Email details are unavailable.') })
      },
    )
    return () => { active = false }
  }, [conversationId, isEmailConversation])

  const current = isEmailConversation && loaded?.conversationId === conversationId ? loaded : null
  return {
    facts: current?.facts ?? null,
    error: current?.error ?? null,
    isLoading: isEmailConversation && conversationId !== null && current === null,
  }
}

/** Why replies on this email conversation cannot be sent now, from its mailbox's sending state. */
export const emailSendUnavailableReason = (facts: ConversationEmailFacts | null): string | null => {
  switch (facts?.sending.state) {
    case 'not_verified':
      return 'Replies wait until this mailbox’s domain is verified.'
    case 'domain_removed':
      return 'This mailbox’s sending domain was removed.'
    default:
      return null
  }
}

const participantLabel = (participant: ConversationEmailFacts['participant']) =>
  participant.displayName ? `${participant.displayName} <${participant.address}>` : participant.address

/** The email envelope of a conversation: who wrote, to which mailbox, and the latest subject. */
export function EmailConversationHeader({ facts, error, isLoading }: EmailFactsState) {
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
    </section>
  )
}
