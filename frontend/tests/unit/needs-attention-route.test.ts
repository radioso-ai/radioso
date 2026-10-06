import { describe, expect, it } from 'vitest'

import {
  needsAttentionNotFoundNotice,
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
      target: { itemKind: 'inbox', itemId: secondApproval.key },
      items: [openItem, secondApproval],
      recentlyClosed: [closedItem],
      isReady: true,
    })).toEqual({ kind: 'item', item: secondApproval })

    expect(resolveNeedsAttentionRouteSelection({
      target: { itemKind: 'inbox', itemId: closedItem.key },
      items: [openItem],
      recentlyClosed: [closedItem],
      isReady: true,
    })).toEqual({ kind: 'recently-closed', item: closedItem })
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
      target: { itemKind: 'inbox', itemId: 'approval:agent-1:missing' },
      items: [],
      recentlyClosed: [],
      isReady: false,
    })).toEqual({ kind: 'pending' })

    expect(resolveNeedsAttentionRouteSelection({
      target: { itemKind: 'inbox', itemId: 'approval:agent-1:missing' },
      items: [],
      recentlyClosed: [],
      isReady: true,
    })).toEqual({ kind: 'missing' })
  })

  it('clears a stale permalink notice when a later route resolves', () => {
    const missing = resolveNeedsAttentionRouteSelection({
      target: { itemKind: 'inbox', itemId: 'approval:agent-1:missing' },
      items: [],
      recentlyClosed: [],
      isReady: true,
    })
    const resolved = resolveNeedsAttentionRouteSelection({
      target: { itemKind: 'inbox', itemId: openItem.key },
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
