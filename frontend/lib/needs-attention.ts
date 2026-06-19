import type { ChatConversationSummary, ConversationOwnership } from '@/lib/api-types'

export type HumanOwnedConversationSummary = ChatConversationSummary & {
  ownership: ConversationOwnership
}

export const selectHumanOwnedConversations = (
  summaries: ChatConversationSummary[],
): HumanOwnedConversationSummary[] =>
  summaries.filter((summary): summary is HumanOwnedConversationSummary => Boolean(summary.ownership))

export const ownershipLabel = (ownership: ConversationOwnership): string => {
  if (ownership.ownerAccountId === null) {
    return 'Awaiting a human'
  }

  return `Handled by ${ownership.ownerDisplayName?.trim() || 'a teammate'}`
}
