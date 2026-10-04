import type { DeliveryFailure, HeldReply } from './api-reply-review'
import { handoffReasonLabel } from './conversation-activity'
import { resolveConversationDisplayTitle } from './conversation-title'
import type { HandoffCandidateSource, InboxItem } from './needs-attention'

/** Where a reply sent to a customer stands, from queued to its final outcome. */
type ReplyDeliveryState = 'queued' | 'accepted' | 'delivered' | 'bounced' | 'failed' | 'uncertain' | 'halted'

const REPLY_DELIVERY_LABEL: Record<ReplyDeliveryState, string> = {
  queued: 'Queued',
  accepted: 'Sent',
  delivered: 'Delivered',
  bounced: 'Bounced',
  failed: 'Failed',
  uncertain: 'Unconfirmed',
  halted: 'Not sent',
}

/**
 * A reply's delivery as operators read it, with the provider's sanitized code when it failed.
 * The code is shown as the provider reported it: it is never the bounce message itself.
 */
export const replyDeliveryLabel = (state: ReplyDeliveryState, code: string | null = null): string =>
  code ? `${REPLY_DELIVERY_LABEL[state]} · ${code}` : REPLY_DELIVERY_LABEL[state]

/** A delivery-failure row before the inbox model ranks it; the model owns every row's severity. */
type DeliveryFailureRow = Omit<InboxItem, 'severity'> & { type: 'delivery_failed' }

/**
 * One Inbox row per open delivery failure: a conversation with two failed replies has two rows.
 * Each waits from the moment the failure opened. A failure carries no conversation facts, so the
 * row borrows its title and agent from the conversation when the Inbox has already loaded it.
 */
export const buildDeliveryFailureRows = (
  failures: readonly DeliveryFailure[],
  conversations: readonly HandoffCandidateSource[],
): DeliveryFailureRow[] => {
  const conversationsById = new Map(conversations.map((conversation) => [conversation.id, conversation]))
  return failures.map((failure) => {
    const conversation = conversationsById.get(failure.conversationId)
    return {
      key: `delivery_failed:${failure.id}`,
      conversationId: failure.conversationId,
      type: 'delivery_failed',
      title: conversation ? resolveConversationDisplayTitle(conversation, 'Undelivered reply') : 'Undelivered reply',
      detail: replyDeliveryLabel(failure.kind, failure.detailCode),
      timestamp: failure.openedAt,
      escalatedAt: failure.openedAt,
      lastMessageAt: conversation?.updatedAt ?? null,
      agentId: conversation?.agentId,
      agentName: conversation?.agentName,
      agentInternalName: conversation?.agentInternalName,
      anonymousSessionId: conversation?.anonymousSessionId,
      deliveryFailure: failure,
    }
  })
}

// Fact codes as operators read them. A code this Inbox does not know reads as words, never raw.
const OUTCOME_LABEL: Readonly<Record<string, string>> = {
  answered: 'Answered',
  no_context: 'No matching documents',
  out_of_scope: 'Out of scope',
  unavailable: 'Answer unavailable',
}

const GROUNDING_LABEL: Readonly<Record<string, string | null>> = {
  grounded: 'Grounded',
  ungrounded: 'Not grounded',
  not_applicable: null,
  unknown: 'Grounding unknown',
}

const COVERAGE_LABEL: Readonly<Record<string, string | null>> = {
  answered: 'Fully answered',
  partial: 'Partly answered',
  unanswered: 'Not answered',
  unclear: 'Coverage unclear',
  unavailable: 'Coverage unavailable',
  not_assessed: null,
}

const codeAsWords = (code: string): string => {
  const words = code.replace(/[_-]+/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

const labelFor = (labels: Readonly<Record<string, string | null>>, code: string): string | null =>
  code in labels ? labels[code] ?? null : codeAsWords(code)

/** How the turn behind a held reply ended: answered, out of scope, and so on. */
export const heldReplyOutcomeLabel = (facts: HeldReply['facts']): string =>
  labelFor(OUTCOME_LABEL, facts.outcome) ?? codeAsWords(facts.outcome)

/** What the turn found, in one line: grounding, coverage, and why it asked for a person. */
export const heldReplyFactsLine = (facts: HeldReply['facts']): string =>
  [
    labelFor(GROUNDING_LABEL, facts.grounding),
    labelFor(COVERAGE_LABEL, facts.coverage),
    facts.handoff.requested ? handoffReasonLabel(facts.handoff.reason) ?? 'Asked for a person' : null,
  ].filter((part): part is string => Boolean(part)).join(' · ')

/** An approval row before the inbox model ranks it; the model owns every row's severity. */
type HeldReplyRow = Omit<InboxItem, 'severity'> & { type: 'approval'; heldReplyId: string }

const firstLine = (text: string) => text.trim().split('\n')[0] ?? ''

/**
 * One approval row per held reply that still waits on an operator — pending, or discarded with
 * nobody having replied since. It waits from the moment the reply was held. A held reply carries
 * no conversation facts, so the row borrows its title and agent from the conversation when the
 * Inbox has already loaded it, and is otherwise titled by the draft itself.
 */
export const buildHeldReplyRows = (
  heldReplies: readonly HeldReply[],
  conversations: readonly HandoffCandidateSource[],
): HeldReplyRow[] => {
  const conversationsById = new Map(conversations.map((conversation) => [conversation.id, conversation]))
  return heldReplies
    .filter((heldReply) => heldReply.attentionOpen && heldReply.state !== 'queued_auto')
    .map((heldReply) => {
      const conversation = conversationsById.get(heldReply.conversationId)
      const draftTitle = firstLine(heldReply.draftText) || 'Draft reply'
      return {
        key: `approval:held:${heldReply.id}`,
        conversationId: heldReply.conversationId,
        type: 'approval',
        heldReplyId: heldReply.id,
        title: conversation ? resolveConversationDisplayTitle(conversation, draftTitle) : draftTitle,
        detail: heldReplyOutcomeLabel(heldReply.facts),
        timestamp: heldReply.createdAt,
        escalatedAt: heldReply.createdAt,
        lastMessageAt: conversation?.updatedAt ?? null,
        agentId: heldReply.agentId ?? conversation?.agentId,
        agentName: conversation?.agentName,
        agentInternalName: conversation?.agentInternalName,
        anonymousSessionId: conversation?.anonymousSessionId,
      }
    })
}
