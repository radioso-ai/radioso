import { describe, expect, it } from 'vitest'

import type { ChatConversationSummary, ConversationOwnership, PendingApprovalDecision } from '@/lib/api-types'
import {
  countNewInboxItems,
  inboxItemKeys,
  ownershipLabel,
  selectHumanOwnedConversations,
  type HumanOwnedConversationSummary,
} from '@/lib/needs-attention'

const ownership = (overrides: Partial<ConversationOwnership> = {}): ConversationOwnership => ({
  conversationId: 'conversation-1',
  workspaceId: 'workspace-1',
  state: 'human_owned',
  ownerAccountId: null,
  ownerDisplayName: null,
  reason: null,
  version: 1,
  takenOverAt: null,
  createdAt: '2026-06-19T10:00:00.000Z',
  updatedAt: '2026-06-19T10:00:00.000Z',
  ...overrides,
})

const conversation = (
  overrides: Partial<ChatConversationSummary> = {},
): ChatConversationSummary => ({
  id: 'conversation-1',
  agentId: 'agent-1',
  agentName: 'Marta',
  sourceChannel: 'authenticated_chat',
  sourceOrigin: null,
  anonymousSessionId: null,
  createdAt: '2026-06-19T10:00:00.000Z',
  updatedAt: '2026-06-19T10:00:00.000Z',
  messageCount: 2,
  userMessageCount: 1,
  assistantMessageCount: 1,
  preview: 'Please help with this order',
  ...overrides,
})

describe('needs attention helpers', () => {
  it('keeps only conversations with human ownership', () => {
    const humanOwned = conversation({
      id: 'conversation-human-owned',
      ownership: ownership({ conversationId: 'conversation-human-owned' }),
    })
    const unowned = conversation({ id: 'conversation-unowned' })
    const aiOwned = conversation({
      id: 'conversation-ai-owned',
      ownership: ownership({
        conversationId: 'conversation-ai-owned',
        state: 'ai_owned',
        ownerAccountId: null,
        ownerDisplayName: null,
      }),
    })

    expect(selectHumanOwnedConversations([humanOwned, unowned, aiOwned])).toEqual([humanOwned])
  })

  it('labels unassigned human ownership as awaiting a human', () => {
    expect(ownershipLabel(ownership({ ownerAccountId: null, ownerDisplayName: null }))).toBe('Awaiting a human')
  })

  it('labels assigned human ownership with the owner display name', () => {
    expect(ownershipLabel(ownership({ ownerAccountId: 'account-2', ownerDisplayName: 'Ada Lovelace' }))).toBe(
      'Handled by Ada Lovelace',
    )
  })

  it('falls back to teammate when assigned ownership has no display name', () => {
    expect(ownershipLabel(ownership({ ownerAccountId: 'account-2', ownerDisplayName: null }))).toBe(
      'Handled by a teammate',
    )
  })
})

const decision = (overrides: Partial<PendingApprovalDecision> = {}): PendingApprovalDecision => ({
  handle: 'decision-1',
  conversationId: 'conversation-1',
  agentId: 'agent-1',
  routineId: 'routine-1',
  stepId: 'step-1',
  reason: 'Approve sending the booking update',
  options: [{ id: 'approve', label: 'Approve' }],
  contentHash: 'hash-1',
  canResolve: true,
  deadline: null,
  createdAt: '2026-06-19T10:00:00.000Z',
  ...overrides,
})

const humanOwned = (
  overrides: Partial<HumanOwnedConversationSummary> = {},
): HumanOwnedConversationSummary => ({
  ...conversation(),
  ownership: ownership(),
  ...overrides,
})

describe('inboxItemKeys', () => {
  it('is stable regardless of item order', () => {
    const a = decision({ handle: 'a', agentId: 'agent-1' })
    const b = decision({ handle: 'b', agentId: 'agent-2' })
    const c1 = humanOwned({ id: 'c-1' })
    const c2 = humanOwned({ id: 'c-2' })

    expect(inboxItemKeys([a, b], [c1, c2])).toEqual(inboxItemKeys([b, a], [c2, c1]))
  })

  it('distinguishes identical handles across different agents', () => {
    const sameAgent = inboxItemKeys([decision({ handle: 'a', agentId: 'agent-1' })], [])
    const otherAgent = inboxItemKeys([decision({ handle: 'a', agentId: 'agent-2' })], [])

    expect(otherAgent).not.toEqual(sameAgent)
  })

  it('changes the key when a human-owned conversation receives new activity', () => {
    const before = inboxItemKeys([], [humanOwned({ id: 'c-1', updatedAt: '2026-06-19T10:00:00.000Z' })])
    const after = inboxItemKeys([], [humanOwned({ id: 'c-1', updatedAt: '2026-06-19T10:05:00.000Z' })])

    expect(after).not.toEqual(before)
  })

  it('changes the key when ownership transitions on an existing conversation', () => {
    const before = inboxItemKeys([], [humanOwned({ id: 'c-1', ownership: ownership({ version: 1 }) })])
    const after = inboxItemKeys([], [humanOwned({ id: 'c-1', ownership: ownership({ version: 2 }) })])

    expect(after).not.toEqual(before)
  })

  it('namespaces approval and conversation keys so they cannot collide', () => {
    const keys = inboxItemKeys([decision({ handle: 'x' })], [humanOwned({ id: 'c-1' })])

    expect(keys.some((key) => key.startsWith('approval:'))).toBe(true)
    expect(keys.some((key) => key.startsWith('conversation:'))).toBe(true)
  })
})

describe('countNewInboxItems', () => {
  it('counts approvals and conversations that arrived after the baseline', () => {
    const baseline = inboxItemKeys([decision({ handle: 'a' })], [humanOwned({ id: 'c-1' })])
    const latest = inboxItemKeys(
      [decision({ handle: 'a' }), decision({ handle: 'b' })],
      [humanOwned({ id: 'c-1' }), humanOwned({ id: 'c-2' })],
    )

    expect(countNewInboxItems(baseline, latest)).toBe(2)
  })

  it('counts an updated conversation as one new item', () => {
    const baseline = inboxItemKeys([], [humanOwned({ id: 'c-1', updatedAt: '2026-06-19T10:00:00.000Z' })])
    const latest = inboxItemKeys([], [humanOwned({ id: 'c-1', updatedAt: '2026-06-19T10:05:00.000Z' })])

    expect(countNewInboxItems(baseline, latest)).toBe(1)
  })

  it('does not count removals such as a resolved approval', () => {
    const baseline = inboxItemKeys([decision({ handle: 'a' }), decision({ handle: 'b' })], [])
    const latest = inboxItemKeys([decision({ handle: 'a' })], [])

    expect(countNewInboxItems(baseline, latest)).toBe(0)
  })

  it('returns zero for an unchanged inbox', () => {
    const baseline = inboxItemKeys([decision({ handle: 'a' })], [humanOwned({ id: 'c-1' })])
    const latest = inboxItemKeys([decision({ handle: 'a' })], [humanOwned({ id: 'c-1' })])

    expect(countNewInboxItems(baseline, latest)).toBe(0)
  })
})
