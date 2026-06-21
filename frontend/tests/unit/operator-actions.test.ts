import { describe, expect, it } from 'vitest'

import type { ConversationOwnership } from '@/lib/api-types'
import { deriveOperatorActions } from '@/lib/operator-actions'

const ownership = (
  overrides: Partial<ConversationOwnership>,
): ConversationOwnership => ({
  conversationId: 'conversation-1',
  workspaceId: 'workspace-1',
  state: 'ai_owned',
  ownerAccountId: null,
  ownerDisplayName: null,
  reason: null,
  version: 1,
  takenOverAt: null,
  createdAt: '2026-06-19T10:00:00.000Z',
  updatedAt: '2026-06-19T10:00:00.000Z',
  ...overrides,
})

describe('deriveOperatorActions', () => {
  it('allows takeover when ownership is absent', () => {
    expect(deriveOperatorActions()).toEqual({
      canTakeOver: true,
      canReply: false,
      canHandBack: false,
      status: 'ai_owned',
      ownerLabel: null,
      version: null,
    })
  })

  it('allows takeover for ai-owned conversations and preserves the version', () => {
    expect(deriveOperatorActions(ownership({ state: 'ai_owned', version: 4 }))).toEqual({
      canTakeOver: true,
      canReply: false,
      canHandBack: false,
      status: 'ai_owned',
      ownerLabel: null,
      version: 4,
    })
  })

  it('treats unassigned human ownership as awaiting a human', () => {
    expect(deriveOperatorActions(ownership({
      state: 'human_owned',
      ownerAccountId: null,
      ownerDisplayName: null,
      version: 5,
    }))).toEqual({
      canTakeOver: true,
      canReply: true,
      canHandBack: true,
      status: 'awaiting_human',
      ownerLabel: null,
      version: 5,
    })
  })

  it('allows reply and handback when a teammate owns the conversation', () => {
    expect(deriveOperatorActions(ownership({
      state: 'human_owned',
      ownerAccountId: 'account-2',
      ownerDisplayName: 'Ada',
      version: 6,
    }))).toEqual({
      canTakeOver: false,
      canReply: true,
      canHandBack: true,
      status: 'human_owned',
      ownerLabel: 'Ada',
      version: 6,
    })
  })

  it('uses a fallback owner label for assigned conversations without a display name', () => {
    expect(deriveOperatorActions(ownership({
      state: 'human_owned',
      ownerAccountId: 'account-2',
      ownerDisplayName: null,
    })).ownerLabel).toBe('A teammate')
  })
})
