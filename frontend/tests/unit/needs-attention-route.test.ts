import { describe, expect, it } from 'vitest'

import { resolveNeedsAttentionRouteSelection } from '@/lib/needs-attention-route'
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

describe('resolveNeedsAttentionRouteSelection', () => {
  it('resolves the shared chat route id against open items before recently closed items', () => {
    expect(resolveNeedsAttentionRouteSelection({
      conversationId: 'conversation-open',
      items: [openItem],
      recentlyClosed: [closedItem],
      isReady: true,
    })).toEqual({ kind: 'item', item: openItem })

    expect(resolveNeedsAttentionRouteSelection({
      conversationId: 'conversation-closed',
      items: [openItem],
      recentlyClosed: [closedItem],
      isReady: true,
    })).toEqual({ kind: 'recently-closed', item: closedItem })
  })

  it('waits for both queues before deciding a permalink is stale', () => {
    expect(resolveNeedsAttentionRouteSelection({
      conversationId: 'conversation-missing',
      items: [],
      recentlyClosed: [],
      isReady: false,
    })).toEqual({ kind: 'pending' })

    expect(resolveNeedsAttentionRouteSelection({
      conversationId: 'conversation-missing',
      items: [],
      recentlyClosed: [],
      isReady: true,
    })).toEqual({ kind: 'missing' })
  })

  it('has no selection when the route does not name a conversation', () => {
    expect(resolveNeedsAttentionRouteSelection({
      conversationId: undefined,
      items: [openItem],
      recentlyClosed: [closedItem],
      isReady: true,
    })).toEqual({ kind: 'none' })
  })
})
