import type { ChatConversationSummary, ConversationOwnership, PendingApprovalDecision } from '@/lib/api-types'

export type HumanOwnedConversationSummary = ChatConversationSummary & {
  ownership: ConversationOwnership
}

/** Page size used when loading the human-owned conversations shown in the inbox. */
export const HUMAN_OWNED_CONVERSATION_PAGE_SIZE = 50

export const selectHumanOwnedConversations = (
  summaries: ChatConversationSummary[],
): HumanOwnedConversationSummary[] =>
  summaries.filter(
    (summary): summary is HumanOwnedConversationSummary => summary.ownership?.state === 'human_owned',
  )

/**
 * Builds an order-independent fingerprint of the inbox contents. The indicator poll compares this
 * against the displayed state to decide whether new activity has arrived: a changed signature means
 * an approval was created or resolved, or a human-owned conversation gained a message or changed
 * ownership. It deliberately captures only identity + freshness markers, not full payloads.
 */
export const inboxSignature = (
  decisions: PendingApprovalDecision[],
  conversations: HumanOwnedConversationSummary[],
): string => {
  const approvalKeys = decisions.map((decision) => `${decision.agentId}:${decision.handle}`).sort()
  const conversationKeys = conversations
    .map((conversation) => `${conversation.id}:${conversation.updatedAt}:${conversation.ownership.version}`)
    .sort()

  return JSON.stringify({ approvals: approvalKeys, conversations: conversationKeys })
}

export const ownershipLabel = (ownership: ConversationOwnership): string => {
  if (ownership.ownerAccountId === null) {
    return 'Awaiting a human'
  }

  return `Handled by ${ownership.ownerDisplayName?.trim() || 'a teammate'}`
}
