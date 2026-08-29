import { describe, expect, it } from 'vitest'

import { deriveConversationOutcome, IN_PROGRESS_WINDOW_MS } from '@/lib/conversation-outcome'
import type { ChatConversationSummary, ConversationOwnership } from '@/lib/api'

const NOW = new Date('2026-08-28T12:00:00.000Z')

const ownership: ConversationOwnership = {
  conversationId: 'conversation-1',
  workspaceId: 'workspace-1',
  state: 'human_owned',
  ownerAccountId: null,
  ownerDisplayName: null,
  reason: null,
  version: 1,
  takenOverAt: NOW.toISOString(),
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
}

const conversation = (
  overrides: Partial<Pick<ChatConversationSummary, 'ownership' | 'updatedAt'>>,
): Pick<ChatConversationSummary, 'ownership' | 'updatedAt'> => ({
  ownership: undefined,
  updatedAt: NOW.toISOString(),
  ...overrides,
})

describe('deriveConversationOutcome', () => {
  it('is handed_off whenever ownership is present, regardless of recency', () => {
    const justUpdated = conversation({
      ownership,
      updatedAt: new Date(NOW.getTime() - 1000).toISOString(),
    })

    expect(deriveConversationOutcome(justUpdated, NOW)).toEqual({ kind: 'handed_off' })
  })

  it('is handed_off for a claimed (non-null owner) conversation too', () => {
    const claimed = conversation({
      ownership: { ...ownership, ownerAccountId: 'account-1', ownerDisplayName: 'Dana' },
    })

    expect(deriveConversationOutcome(claimed, NOW)).toEqual({ kind: 'handed_off' })
  })

  it('is in_progress when updated just under the window and unowned', () => {
    const recent = conversation({
      updatedAt: new Date(NOW.getTime() - (IN_PROGRESS_WINDOW_MS - 60_000)).toISOString(),
    })

    expect(deriveConversationOutcome(recent, NOW)).toEqual({ kind: 'in_progress' })
  })

  it('is in_progress exactly at the 10-minute boundary', () => {
    const atBoundary = conversation({
      updatedAt: new Date(NOW.getTime() - IN_PROGRESS_WINDOW_MS).toISOString(),
    })

    expect(deriveConversationOutcome(atBoundary, NOW)).toEqual({ kind: 'in_progress' })
  })

  it('is completed one second past the 10-minute boundary', () => {
    const pastBoundary = conversation({
      updatedAt: new Date(NOW.getTime() - IN_PROGRESS_WINDOW_MS - 1000).toISOString(),
    })

    expect(deriveConversationOutcome(pastBoundary, NOW)).toEqual({ kind: 'completed' })
  })

  it('is completed well outside the window and unowned', () => {
    const old = conversation({
      updatedAt: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(),
    })

    expect(deriveConversationOutcome(old, NOW)).toEqual({ kind: 'completed' })
  })
})
