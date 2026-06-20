import { describe, expect, it } from 'vitest'

import type { ChatConversationSummary, ConversationOwnership, PendingApprovalDecision } from '@/lib/api-types'
import {
  inboxSignature,
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

describe('inboxSignature', () => {
  it('is stable regardless of item order', () => {
    const a = decision({ handle: 'a', agentId: 'agent-1' })
    const b = decision({ handle: 'b', agentId: 'agent-2' })
    const c1 = humanOwned({ id: 'c-1' })
    const c2 = humanOwned({ id: 'c-2' })

    expect(inboxSignature([a, b], [c1, c2])).toBe(inboxSignature([b, a], [c2, c1]))
  })

  it('changes when a new pending approval arrives', () => {
    const before = inboxSignature([decision({ handle: 'a' })], [])
    const after = inboxSignature([decision({ handle: 'a' }), decision({ handle: 'b' })], [])

    expect(after).not.toBe(before)
  })

  it('changes when an approval is resolved away', () => {
    const before = inboxSignature([decision({ handle: 'a' }), decision({ handle: 'b' })], [])
    const after = inboxSignature([decision({ handle: 'a' })], [])

    expect(after).not.toBe(before)
  })

  it('distinguishes identical handles across different agents', () => {
    const sameAgent = inboxSignature([decision({ handle: 'a', agentId: 'agent-1' })], [])
    const otherAgent = inboxSignature([decision({ handle: 'a', agentId: 'agent-2' })], [])

    expect(otherAgent).not.toBe(sameAgent)
  })

  it('changes when a human-owned conversation receives new activity', () => {
    const before = inboxSignature([], [humanOwned({ id: 'c-1', updatedAt: '2026-06-19T10:00:00.000Z' })])
    const after = inboxSignature([], [humanOwned({ id: 'c-1', updatedAt: '2026-06-19T10:05:00.000Z' })])

    expect(after).not.toBe(before)
  })

  it('changes when ownership transitions on an existing conversation', () => {
    const before = inboxSignature([], [humanOwned({ id: 'c-1', ownership: ownership({ version: 1 }) })])
    const after = inboxSignature([], [humanOwned({ id: 'c-1', ownership: ownership({ version: 2 }) })])

    expect(after).not.toBe(before)
  })

  it('is identical for unchanged inbox state', () => {
    const decisions = [decision({ handle: 'a' })]
    const conversations = [humanOwned({ id: 'c-1' })]

    expect(inboxSignature(decisions, conversations)).toBe(
      inboxSignature([decision({ handle: 'a' })], [humanOwned({ id: 'c-1' })]),
    )
  })
})
