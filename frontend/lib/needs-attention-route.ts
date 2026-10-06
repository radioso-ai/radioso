import type { InboxItem, RecentlyClosedInboxItem } from './needs-attention'

/**
 * Resolves the shared Activity `itemKind=chat&itemId=<conversationId>` route
 * against the two Needs-you queues. Queue keys identify an escalation, while
 * the route deliberately identifies the conversation so both Activity lenses
 * use the same permalink contract.
 */
export const resolveNeedsAttentionRouteSelection = ({
  conversationId,
  items,
  recentlyClosed,
  isReady,
}: {
  conversationId?: string
  items: readonly InboxItem[]
  recentlyClosed: readonly RecentlyClosedInboxItem[]
  isReady: boolean
}):
  | { kind: 'none' }
  | { kind: 'pending' }
  | { kind: 'missing' }
  | { kind: 'item'; item: InboxItem }
  | { kind: 'recently-closed'; item: RecentlyClosedInboxItem } => {
  if (!conversationId) return { kind: 'none' }

  const item = items.find((candidate) => candidate.conversationId === conversationId)
  if (item) return { kind: 'item', item }

  const recentlyClosedItem = recentlyClosed.find((candidate) => candidate.conversationId === conversationId)
  if (recentlyClosedItem) return { kind: 'recently-closed', item: recentlyClosedItem }

  return isReady ? { kind: 'missing' } : { kind: 'pending' }
}
