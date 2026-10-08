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

const routeTargetConversationId = (target: NeedsAttentionRouteTarget): string | null =>
  target.itemKind === 'chat' ? target.itemId : conversationIdFromNeedsAttentionRouteItemId(target.itemId)

/**
 * The route target an item action (chiefly a not-found clear) should name:
 * `routeTarget` itself when it still names `item`'s conversation - so a
 * legacy `chat`-kind All-lens permalink keeps its own shape - and the item's
 * own synthesized `inbox`-kind key otherwise. A click commits its local
 * selection before `routeTarget` catches up with the navigation that names
 * it (`needs-attention-view.tsx` tracks the gap via
 * `pendingSelectFromRouteKeyRef`); a fast 404 landing in that gap must act
 * on the item that actually failed, not the previous selection `routeTarget`
 * still names.
 */
export const needsAttentionRouteTargetForItemAction = (
  item: InboxItem | RecentlyClosedInboxItem,
  routeTarget: NeedsAttentionRouteTarget | undefined,
): NeedsAttentionRouteTarget => (
  routeTarget && routeTargetConversationId(routeTarget) === item.conversationId
    ? routeTarget
    : needsAttentionRouteTargetForItem(item)
)

/** Retains local object identity when polling recreates an unchanged queue row. */
export const preserveMatchingQueueItem = <T extends { key: string }>(
  current: T | null,
  next: T,
): T => current?.key === next.key ? current : next

export const resolveNeedsAttentionRouteSelection = ({
  target,
  items,
  recentlyClosed,
  open = null,
  isReady,
}: {
  target?: NeedsAttentionRouteTarget
  items: readonly InboxItem[]
  recentlyClosed: readonly RecentlyClosedInboxItem[]
  /** The row the reading pane shows now, if any. */
  open?: InboxItem | RecentlyClosedInboxItem | null
  isReady: boolean
}):
  NeedsAttentionRouteSelection => {
  if (!target) return { kind: 'none' }

  const matchesTarget = (candidate: InboxItem | RecentlyClosedInboxItem) => target.itemKind === 'inbox'
    ? needsAttentionRouteItemIdForItem(candidate) === target.itemId
    : candidate.conversationId === target.itemId

  const item = items.find(matchesTarget)
  if (item) return { kind: 'item', item }

  const recentlyClosedItem = recentlyClosed.find(matchesTarget)
  if (recentlyClosedItem) return { kind: 'recently-closed', item: recentlyClosedItem }

  // A row leaves the queue while it is open when the operator sends, resolves, or is beaten to it,
  // and the pane stays on it to say what happened. Only the conversation itself being gone, which
  // the pane's own read reports, closes it.
  if (open && matchesTarget(open)) {
    return 'itemKind' in open ? { kind: 'recently-closed', item: open } : { kind: 'item', item: open }
  }

  return isReady ? { kind: 'missing' } : { kind: 'pending' }
}
