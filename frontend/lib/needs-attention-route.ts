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

export const needsAttentionRouteTargetForItem = (
  item: InboxItem | RecentlyClosedInboxItem,
): NeedsAttentionRouteTarget => ({ itemKind: 'inbox', itemId: item.key })

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
    ? candidate.key === target.itemId
    : candidate.conversationId === target.itemId)
  if (item) return { kind: 'item', item }

  const recentlyClosedItem = recentlyClosed.find((candidate) => target.itemKind === 'inbox'
    ? candidate.key === target.itemId
    : candidate.conversationId === target.itemId)
  if (recentlyClosedItem) return { kind: 'recently-closed', item: recentlyClosedItem }

  return isReady ? { kind: 'missing' } : { kind: 'pending' }
}
