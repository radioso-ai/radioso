import type { DeliveryFailure } from './api-reply-review'
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
