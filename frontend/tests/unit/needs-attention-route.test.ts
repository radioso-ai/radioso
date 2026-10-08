import { describe, expect, it } from 'vitest'

import {
  conversationIdFromNeedsAttentionRouteItemId,
  needsAttentionNotFoundNotice,
  needsAttentionRouteItemIdForItem,
  needsAttentionRouteTargetForItem,
  needsAttentionRouteTargetForItemAction,
  preserveMatchingQueueItem,
  resolveNeedsAttentionRouteSelection,
} from '@/lib/needs-attention-route'
import type { InboxItem, RecentlyClosedInboxItem } from '@/lib/needs-attention'

const openItem: InboxItem = {
  key: 'handoff:conversation-open',
  conversationId: 'conversation-open',
  type: 'handoff',
  severity: 'critical',
  title: 'Open handoff',
  detail: 'Needs a person',
  timestamp: '2026-10-06T10:00:00.000Z',
}

const closedItem: RecentlyClosedInboxItem = {
  key: 'closed:conversation-closed',
  conversationId: 'conversation-closed',
  title: 'Closed handoff',
  itemKind: 'handoff',
  outcome: 'handed_back',
  closedAt: '2026-10-06T10:00:00.000Z',
  closedBy: null,
  decisionLabel: null,
}

const secondApproval: InboxItem = {
  ...openItem,
  key: 'approval:agent-1:second',
  type: 'approval',
  title: 'Second approval',
}

describe('resolveNeedsAttentionRouteSelection', () => {
  it('resolves an inbox row id exactly, including when rows share a conversation', () => {
    expect(resolveNeedsAttentionRouteSelection({
      target: needsAttentionRouteTargetForItem(secondApproval),
      items: [openItem, secondApproval],
      recentlyClosed: [closedItem],
      isReady: true,
    })).toEqual({ kind: 'item', item: secondApproval })

    expect(resolveNeedsAttentionRouteSelection({
      target: needsAttentionRouteTargetForItem(closedItem),
      items: [openItem],
      recentlyClosed: [closedItem],
      isReady: true,
    })).toEqual({ kind: 'recently-closed', item: closedItem })
  })

  it('uses a stable handoff route id when ownership changes its queue key', () => {
    const selectedAtVersionOne = { ...openItem, key: 'handoff:conversation-open:1' }
    const refreshedAtVersionTwo = { ...openItem, key: 'handoff:conversation-open:2' }
    const target = needsAttentionRouteTargetForItem(selectedAtVersionOne)

    expect(target).toEqual({ itemKind: 'inbox', itemId: 'inbox:handoff:conversation-open:handoff' })
    expect(resolveNeedsAttentionRouteSelection({
      target,
      items: [refreshedAtVersionTwo],
      recentlyClosed: [],
      isReady: true,
    })).toEqual({ kind: 'item', item: refreshedAtVersionTwo })
  })

  it('embeds the conversation id in stable inbox route ids for page context', () => {
    const routeId = needsAttentionRouteItemIdForItem({
      ...secondApproval,
      conversationId: 'conversation:with/special characters',
    })

    expect(conversationIdFromNeedsAttentionRouteItemId(routeId)).toBe('conversation:with/special characters')
    expect(conversationIdFromNeedsAttentionRouteItemId('approval:agent-1:second')).toBeNull()
  })

  it('keeps conversation-only chat permalinks as an open-queue fallback', () => {
    expect(resolveNeedsAttentionRouteSelection({
      target: { itemKind: 'chat', itemId: 'conversation-open' },
      items: [openItem, secondApproval],
      recentlyClosed: [closedItem],
      isReady: true,
    })).toEqual({ kind: 'item', item: openItem })
  })

  it('waits for both queues before deciding a permalink is stale', () => {
    expect(resolveNeedsAttentionRouteSelection({
      target: { itemKind: 'inbox', itemId: 'inbox:approval:conversation-open:approval:agent-1:missing' },
      items: [],
      recentlyClosed: [],
      isReady: false,
    })).toEqual({ kind: 'pending' })

    expect(resolveNeedsAttentionRouteSelection({
      target: { itemKind: 'inbox', itemId: 'inbox:approval:conversation-open:approval:agent-1:missing' },
      items: [],
      recentlyClosed: [],
      isReady: true,
    })).toEqual({ kind: 'missing' })
  })

  it('keeps the open row when it leaves the queue, and calls only an unopened permalink missing', () => {
    const target = needsAttentionRouteTargetForItem(secondApproval)

    expect(resolveNeedsAttentionRouteSelection({
      target,
      items: [openItem],
      recentlyClosed: [],
      open: secondApproval,
      isReady: true,
    })).toEqual({ kind: 'item', item: secondApproval })

    expect(resolveNeedsAttentionRouteSelection({
      target: needsAttentionRouteTargetForItem(closedItem),
      items: [],
      recentlyClosed: [],
      open: closedItem,
      isReady: true,
    })).toEqual({ kind: 'recently-closed', item: closedItem })

    expect(resolveNeedsAttentionRouteSelection({
      target,
      items: [openItem],
      recentlyClosed: [],
      open: openItem,
      isReady: true,
    })).toEqual({ kind: 'missing' })

    expect(resolveNeedsAttentionRouteSelection({
      target,
      items: [],
      recentlyClosed: [],
      open: null,
      isReady: true,
    })).toEqual({ kind: 'missing' })
  })

  it('clears a stale permalink notice when a later route resolves', () => {
    const missing = resolveNeedsAttentionRouteSelection({
      target: { itemKind: 'inbox', itemId: 'inbox:approval:conversation-open:approval:agent-1:missing' },
      items: [],
      recentlyClosed: [],
      isReady: true,
    })
    const resolved = resolveNeedsAttentionRouteSelection({
      target: needsAttentionRouteTargetForItem(openItem),
      items: [openItem],
      recentlyClosed: [],
      isReady: true,
    })

    expect(needsAttentionNotFoundNotice(missing)).toBe('This conversation is no longer available.')
    expect(needsAttentionNotFoundNotice(resolved)).toBeNull()
  })

  it('has no selection when the route does not name a Needs-you target', () => {
    expect(resolveNeedsAttentionRouteSelection({
      target: undefined,
      items: [openItem],
      recentlyClosed: [closedItem],
      isReady: true,
    })).toEqual({ kind: 'none' })
  })

  it('keeps the current selected row when a refreshed queue recreates its object', () => {
    const refreshed = { ...closedItem }
    expect(preserveMatchingQueueItem(closedItem, refreshed)).toBe(closedItem)
    const different = { ...closedItem, key: 'closed:other' }
    expect(preserveMatchingQueueItem(closedItem, different)).toBe(different)
  })
})

describe('needsAttentionRouteTargetForItemAction', () => {
  it('uses the item\'s own key when there is no route target at all', () => {
    expect(needsAttentionRouteTargetForItemAction(openItem, undefined))
      .toEqual(needsAttentionRouteTargetForItem(openItem))
  })

  it('uses the item\'s own key when the route target still names a different conversation - ' +
    'the shape of a click whose own navigation has not landed yet, leaving routeTarget naming the previous row', () => {
    const staleRouteTarget = needsAttentionRouteTargetForItem(closedItem)

    expect(needsAttentionRouteTargetForItemAction(openItem, staleRouteTarget))
      .toEqual(needsAttentionRouteTargetForItem(openItem))
  })

  it('keeps the stale route target verbatim when it names a different row on the same conversation', () => {
    const sameConversationStaleTarget = needsAttentionRouteTargetForItem(secondApproval)

    expect(needsAttentionRouteTargetForItemAction(openItem, sameConversationStaleTarget))
      .toEqual(sameConversationStaleTarget)
  })

  it('keeps a legacy chat-kind permalink\'s own shape when it still names the item', () => {
    const chatRouteTarget = { itemKind: 'chat' as const, itemId: openItem.conversationId }

    expect(needsAttentionRouteTargetForItemAction(openItem, chatRouteTarget)).toEqual(chatRouteTarget)
  })

  it('keeps an inbox-kind route target verbatim when it already names the item', () => {
    const inboxRouteTarget = needsAttentionRouteTargetForItem(openItem)

    expect(needsAttentionRouteTargetForItemAction(openItem, inboxRouteTarget)).toEqual(inboxRouteTarget)
  })

  it('falls back to the item\'s own key for a different item under the same stale chat-kind target', () => {
    const staleChatRouteTarget = { itemKind: 'chat' as const, itemId: openItem.conversationId }

    expect(needsAttentionRouteTargetForItemAction(closedItem, staleChatRouteTarget))
      .toEqual(needsAttentionRouteTargetForItem(closedItem))
  })
})
