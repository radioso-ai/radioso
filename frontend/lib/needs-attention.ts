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
 * Builds an order-independent key per inbox item. The indicator poll diffs the latest keys against
 * the displayed state to detect new activity: a key changes when an approval is created, or a
 * human-owned conversation gains a message or changes ownership. Keys capture only identity +
 * freshness markers (never payloads), and approval vs conversation keys are namespaced so they
 * can't collide.
 */
export const inboxItemKeys = (
  decisions: PendingApprovalDecision[],
  conversations: HumanOwnedConversationSummary[],
): string[] => {
  const approvalKeys = decisions.map((decision) => `approval:${decision.agentId}:${decision.handle}`)
  const conversationKeys = conversations.map(
    (conversation) => `conversation:${conversation.id}:${conversation.updatedAt}:${conversation.ownership.version}`,
  )

  return [...approvalKeys, ...conversationKeys].sort()
}

/**
 * Counts how many of the latest inbox keys are not present in the operator's displayed state — i.e.
 * the number of newly-arrived or freshly-updated items since the last refresh. Removals (an approval
 * resolved elsewhere, a conversation handed back to the AI) are not counted as new activity.
 */
export const countNewInboxItems = (
  baselineKeys: readonly string[],
  latestKeys: readonly string[],
): number => {
  const baseline = new Set(baselineKeys)
  let count = 0
  for (const key of latestKeys) {
    if (!baseline.has(key)) {
      count += 1
    }
  }
  return count
}

export const ownershipLabel = (ownership: ConversationOwnership): string => {
  if (ownership.ownerAccountId === null) {
    return 'Awaiting a human'
  }

  return `Handled by ${ownership.ownerDisplayName?.trim() || 'a teammate'}`
}
