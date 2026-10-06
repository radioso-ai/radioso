import type { InboxItem, RecentlyClosedInboxItem } from './needs-attention'

/**
 * Needs-you rows have queue-local keys, while old All-lens permalinks name a
 * conversation. Both fit in the established Activity item fields: `inbox`
 * identifies one queue row, and `chat` remains a conversation-level fallback.
 */
export type NeedsAttentionRouteTarget =
  | { itemKind: 'inbox'; itemId: string }
  | { itemKind: 'chat'; itemId: string }

type NeedsAttentionRouteSelection =
  | { kind: 'none' }
  | { kind: 'pending' }
  | { kind: 'missing' }
  | { kind: 'item'; item: InboxItem }
  | { kind: 'recently-closed'; item: RecentlyClosedInboxItem }

export const needsAttentionNotFoundNotice = (selection: NeedsAttentionRouteSelection): string | null =>
  selection.kind === 'missing' ? 'This conversation is no longer available.' : null

/**
 * Queue keys are implementation details: handoff keys include the ownership
 * version so polling can notice updates. Route ids instead name the durable
 * row: kind + conversation + the stable source event when one is needed.
 */
export const needsAttentionRouteItemIdForItem = (
  item: InboxItem | RecentlyClosedInboxItem,
): string => {
  const isRecentlyClosed = 'itemKind' in item
  const rowKind = isRecentlyClosed ? item.itemKind : item.type
  const stableEventId = isRecentlyClosed || item.type !== 'handoff' ? item.key : 'handoff'
  return `inbox:${rowKind}:${encodeURIComponent(item.conversationId)}:${stableEventId}`
}

/** Extracts the embedded conversation id without consulting queue data. */
export const conversationIdFromNeedsAttentionRouteItemId = (itemId: string | undefined): string | null => {
  if (!itemId) return null
  const [prefix, rowKind, encodedConversationId, ...eventId] = itemId.split(':')
  if (prefix !== 'inbox' || !rowKind || !encodedConversationId || eventId.length === 0) {
    return null
  }
  try {
    return decodeURIComponent(encodedConversationId)
  } catch {
    return null
  }
}

export const needsAttentionRouteTargetForItem = (
  item: InboxItem | RecentlyClosedInboxItem,
): NeedsAttentionRouteTarget => ({ itemKind: 'inbox', itemId: needsAttentionRouteItemIdForItem(item) })

export const needsAttentionRouteTargetKey = (target: NeedsAttentionRouteTarget | undefined): string | null =>
  target ? `${target.itemKind}:${target.itemId}` : null

/** Retains local object identity when polling recreates an unchanged queue row. */
export const preserveMatchingQueueItem = <T extends { key: string }>(
  current: T | null,
  next: T,
): T => current?.key === next.key ? current : next

export const resolveNeedsAttentionRouteSelection = ({
  target,
  items,
  recentlyClosed,
  isReady,
}: {
  target?: NeedsAttentionRouteTarget
  items: readonly InboxItem[]
  recentlyClosed: readonly RecentlyClosedInboxItem[]
  isReady: boolean
}):
  NeedsAttentionRouteSelection => {
  if (!target) return { kind: 'none' }

  const item = items.find((candidate) => target.itemKind === 'inbox'
    ? needsAttentionRouteItemIdForItem(candidate) === target.itemId
    : candidate.conversationId === target.itemId)
  if (item) return { kind: 'item', item }

  const recentlyClosedItem = recentlyClosed.find((candidate) => target.itemKind === 'inbox'
    ? needsAttentionRouteItemIdForItem(candidate) === target.itemId
    : candidate.conversationId === target.itemId)
  if (recentlyClosedItem) return { kind: 'recently-closed', item: recentlyClosedItem }

  return isReady ? { kind: 'missing' } : { kind: 'pending' }
}
