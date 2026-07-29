import { describe, expect, it } from 'vitest'

import type { ChatConversationSummary, ConversationOwnership, LowQualityTurn, PendingApprovalDecision } from '@/lib/api'
import {
  buildInboxModel,
  buildInboxItems,
  countNewInboxItems,
  formatInboxDuration,
  inboxItemKeys,
  ownershipLabel,
  QUALITY_INBOX_ITEM_LIMIT,
  selectHumanOwnedConversations,
  waitingTone,
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
  channelContext: null,
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

    expect(inboxItemKeys([a, b], [c1, c2], [])).toEqual(inboxItemKeys([b, a], [c2, c1], []))
  })

  it('distinguishes identical handles across different agents', () => {
    const sameAgent = inboxItemKeys([decision({ handle: 'a', agentId: 'agent-1' })], [], [])
    const otherAgent = inboxItemKeys([decision({ handle: 'a', agentId: 'agent-2' })], [], [])

    expect(otherAgent).not.toEqual(sameAgent)
  })

  it('changes the key when a human-owned conversation receives new activity', () => {
    const before = inboxItemKeys([], [humanOwned({ id: 'c-1', updatedAt: '2026-06-19T10:00:00.000Z' })], [])
    const after = inboxItemKeys([], [humanOwned({ id: 'c-1', updatedAt: '2026-06-19T10:05:00.000Z' })], [])

    expect(after).not.toEqual(before)
  })

  it('changes the key when ownership transitions on an existing conversation', () => {
    const before = inboxItemKeys([], [humanOwned({ id: 'c-1', ownership: ownership({ version: 1 }) })], [])
    const after = inboxItemKeys([], [humanOwned({ id: 'c-1', ownership: ownership({ version: 2 }) })], [])

    expect(after).not.toEqual(before)
  })

  it('namespaces approval and conversation keys so they cannot collide', () => {
    const keys = inboxItemKeys([decision({ handle: 'x' })], [humanOwned({ id: 'c-1' })], [])

    expect(keys.some((key) => key.startsWith('approval:'))).toBe(true)
    expect(keys.some((key) => key.startsWith('conversation:'))).toBe(true)
  })

  it('includes identity-only keys for quality turns', () => {
    expect(inboxItemKeys([], [], [qualityTurn({ assistantMessageId: 'quality-1' })])).toEqual(['quality:quality-1'])
  })

  it('changes a quality key when a down-vote or written comment is added', () => {
    const before = inboxItemKeys([], [], [qualityTurn({ assistantMessageId: 'quality-1' })])
    const afterVote = inboxItemKeys([], [], [qualityTurn({
      assistantMessageId: 'quality-1',
      feedback: {
        upCount: 0,
        downCount: 1,
        latestDownUpdatedAt: '2026-06-19T10:04:00.000Z',
        comments: [],
      },
    })])
    const afterComment = inboxItemKeys([], [], [qualityTurn({
      assistantMessageId: 'quality-1',
      feedback: {
        upCount: 0,
        downCount: 1,
        latestDownUpdatedAt: '2026-06-19T10:05:00.000Z',
        comments: [{
          value: 'down',
          comment: 'This misses the exception.',
          createdAt: '2026-06-19T10:05:00.000Z',
          updatedAt: '2026-06-19T10:05:00.000Z',
        }],
      },
    })])

    expect(afterVote).not.toEqual(before)
    expect(afterComment).not.toEqual(afterVote)
  })

  it('omits a quality key when the same conversation has a critical escalation', () => {
    expect(inboxItemKeys(
      [decision({ conversationId: 'shared-conversation' })],
      [],
      [qualityTurn({ conversationId: 'shared-conversation' })],
    )).toEqual([`approval:agent-1:decision-1`])
  })
})

const qualityTurn = (overrides: Partial<LowQualityTurn> = {}): LowQualityTurn => ({
  assistantMessageId: 'message-1',
  conversationId: 'conversation-q1',
  agentId: 'agent-1',
  agentName: 'Marta',
  channel: 'authenticated_chat',
  question: 'What is your refund policy?',
  answerPreview: 'I could not find that in the documents.',
  skillName: 'retrieval.answer',
  skillOutcome: 'no_context',
  skillStatus: 'completed',
  totalLatencyMs: 1200,
  createdAt: '2026-06-19T10:00:00.000Z',
  feedback: {
    upCount: 0,
    downCount: 0,
    latestDownUpdatedAt: null,
    comments: [],
  },
  triage: { state: 'open', reason: null, updatedAt: null },
  ...overrides,
})

describe('buildInboxItems', () => {
  it('tags each source with its escalation type and severity', () => {
    const items = buildInboxItems({
      decisions: [decision({ handle: 'd1', conversationId: 'c-approval' })],
      conversations: [humanOwned({ id: 'c-handoff' })],
      qualityTurns: [
        qualityTurn({ assistantMessageId: 'm-deg', conversationId: 'c-deg', skillOutcome: 'grounded_degraded' }),
        qualityTurn({ assistantMessageId: 'm-noctx', conversationId: 'c-noctx', skillOutcome: 'no_context' }),
      ],
    })

    const byConversation = Object.fromEntries(items.map((item) => [item.conversationId, item]))
    expect(byConversation['c-approval']).toMatchObject({ type: 'approval', severity: 'critical' })
    expect(byConversation['c-handoff']).toMatchObject({ type: 'handoff', severity: 'critical' })
    expect(byConversation['c-deg']).toMatchObject({ type: 'degraded', severity: 'lower' })
    expect(byConversation['c-noctx']).toMatchObject({ type: 'no_context', severity: 'lower' })
    // Quality rows carry the turn id so they can be triaged from the inbox; criticals do not.
    expect(byConversation['c-noctx'].assistantMessageId).toBe('m-noctx')
    expect(byConversation['c-approval'].assistantMessageId).toBeUndefined()
    expect(byConversation['c-handoff'].assistantMessageId).toBeUndefined()
    expect(byConversation['c-approval'].escalatedAt).toBe('2026-06-19T10:00:00.000Z')
    expect(byConversation['c-handoff'].escalatedAt).toBe('2026-06-19T10:00:00.000Z')
  })

  it('maps a down-vote to explicit negative feedback and preserves its evidence', () => {
    const items = buildInboxItems({
      decisions: [],
      conversations: [],
      qualityTurns: [
        qualityTurn({
          assistantMessageId: 'm-feedback',
          conversationId: 'c-feedback',
          agentId: 'agent-feedback',
          agentName: 'Support',
          question: 'Can I return an opened item?',
          answerPreview: 'Items can be returned within 30 days.',
          feedback: {
            upCount: 0,
            downCount: 1,
            latestDownUpdatedAt: '2026-06-19T10:05:00.000Z',
            comments: [{
              value: 'down',
              comment: 'This does not explain the opened-item exception.',
              createdAt: '2026-06-19T10:05:00.000Z',
              updatedAt: '2026-06-19T10:05:00.000Z',
            }],
          },
          triage: {
            state: 'acknowledged',
            reason: null,
            updatedAt: '2026-06-19T10:06:00.000Z',
          },
        }),
      ],
    })

    expect(items).toEqual([
      expect.objectContaining({
        type: 'negative_feedback',
        severity: 'feedback',
        title: 'Can I return an opened item?',
        detail: 'This does not explain the opened-item exception.',
        feedbackComment: 'This does not explain the opened-item exception.',
        answerPreview: 'Items can be returned within 30 days.',
        agentId: 'agent-feedback',
        agentName: 'Support',
        triageState: 'acknowledged',
      }),
    ])
  })

  it('orders critical escalations above lower-concern quality signals', () => {
    const items = buildInboxItems({
      decisions: [decision({ handle: 'd1', conversationId: 'c-approval' })],
      conversations: [humanOwned({ id: 'c-handoff' })],
      qualityTurns: [qualityTurn({ conversationId: 'c-quality' })],
    })

    const severities = items.map((item) => item.severity)
    expect(severities).toEqual(['critical', 'critical', 'lower'])
  })

  it('orders explicit feedback below blocking work and above passive quality signals', () => {
    const items = buildInboxItems({
      decisions: [decision({ conversationId: 'approval' })],
      conversations: [],
      qualityTurns: [
        qualityTurn({
          assistantMessageId: 'passive-newer',
          conversationId: 'passive',
          createdAt: '2026-06-19T12:00:00.000Z',
        }),
        qualityTurn({
          assistantMessageId: 'feedback-older',
          conversationId: 'feedback',
          createdAt: '2026-06-19T09:00:00.000Z',
          feedback: {
            upCount: 0,
            downCount: 1,
            latestDownUpdatedAt: '2026-06-19T09:05:00.000Z',
            comments: [],
          },
        }),
      ],
    })

    expect(items.map((item) => item.conversationId)).toEqual(['approval', 'feedback', 'passive'])
  })

  it('prioritizes commented feedback and keeps it over a newer passive signal in the same conversation', () => {
    const items = buildInboxItems({
      decisions: [],
      conversations: [],
      qualityTurns: [
        qualityTurn({
          assistantMessageId: 'feedback-commented',
          conversationId: 'commented',
          createdAt: '2026-06-19T08:00:00.000Z',
          feedback: {
            upCount: 0,
            downCount: 1,
            latestDownUpdatedAt: '2026-06-19T08:05:00.000Z',
            comments: [{
              value: 'down',
              comment: 'The exception is missing.',
              createdAt: '2026-06-19T08:05:00.000Z',
              updatedAt: '2026-06-19T08:05:00.000Z',
            }],
          },
        }),
        qualityTurn({
          assistantMessageId: 'feedback-uncommented',
          conversationId: 'uncommented',
          createdAt: '2026-06-19T11:00:00.000Z',
          feedback: {
            upCount: 0,
            downCount: 1,
            latestDownUpdatedAt: '2026-06-19T11:05:00.000Z',
            comments: [],
          },
        }),
        qualityTurn({
          assistantMessageId: 'passive-newer',
          conversationId: 'commented',
          createdAt: '2026-06-19T12:00:00.000Z',
        }),
      ],
    })

    expect(items.map((item) => item.assistantMessageId)).toEqual([
      'feedback-commented',
      'feedback-uncommented',
    ])
  })

  it('orders equal-priority feedback by feedback activity instead of answer creation time', () => {
    const items = buildInboxItems({
      decisions: [],
      conversations: [],
      qualityTurns: [
        qualityTurn({
          assistantMessageId: 'new-answer-old-feedback',
          conversationId: 'new-answer',
          createdAt: '2026-06-19T12:00:00.000Z',
          feedback: {
            upCount: 0,
            downCount: 1,
            latestDownUpdatedAt: '2026-06-19T12:05:00.000Z',
            comments: [],
          },
        }),
        qualityTurn({
          assistantMessageId: 'old-answer-fresh-feedback',
          conversationId: 'old-answer',
          createdAt: '2026-01-01T08:00:00.000Z',
          feedback: {
            upCount: 0,
            downCount: 1,
            latestDownUpdatedAt: '2026-06-20T09:00:00.000Z',
            comments: [],
          },
        }),
      ],
    })

    expect(items.map((item) => item.assistantMessageId)).toEqual([
      'old-answer-fresh-feedback',
      'new-answer-old-feedback',
    ])
    expect(items[0]?.timestamp).toBe('2026-06-20T09:00:00.000Z')
  })

  it('keeps the freshest feedback turn when one conversation has multiple downvoted answers', () => {
    const items = buildInboxItems({
      decisions: [],
      conversations: [],
      qualityTurns: [
        qualityTurn({
          assistantMessageId: 'new-answer-old-feedback',
          conversationId: 'shared-conversation',
          createdAt: '2026-06-19T12:00:00.000Z',
          feedback: {
            upCount: 0,
            downCount: 1,
            latestDownUpdatedAt: '2026-06-19T12:05:00.000Z',
            comments: [],
          },
        }),
        qualityTurn({
          assistantMessageId: 'old-answer-fresh-feedback',
          conversationId: 'shared-conversation',
          createdAt: '2026-01-01T08:00:00.000Z',
          feedback: {
            upCount: 0,
            downCount: 1,
            latestDownUpdatedAt: '2026-06-20T09:00:00.000Z',
            comments: [],
          },
        }),
      ],
    })

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      assistantMessageId: 'old-answer-fresh-feedback',
      timestamp: '2026-06-20T09:00:00.000Z',
    })
  })

  it('orders critical items oldest-first while keeping quality signals newest-first below them', () => {
    const items = buildInboxItems({
      decisions: [decision({ conversationId: 'approval-newer', createdAt: '2026-06-19T11:00:00.000Z' })],
      conversations: [humanOwned({
        id: 'handoff-older',
        ownership: ownership({ updatedAt: '2026-06-19T09:00:00.000Z' }),
      })],
      qualityTurns: [
        qualityTurn({ conversationId: 'quality-older', createdAt: '2026-06-19T08:00:00.000Z' }),
        qualityTurn({ conversationId: 'quality-newer', createdAt: '2026-06-19T12:00:00.000Z' }),
      ],
    })

    expect(items.map((item) => item.conversationId)).toEqual([
      'handoff-older',
      'approval-newer',
      'quality-newer',
      'quality-older',
    ])
  })

  it('drops a quality signal whose conversation is already escalated (critical wins)', () => {
    const items = buildInboxItems({
      decisions: [],
      conversations: [humanOwned({ id: 'c-shared' })],
      // Same conversation as the handoff — e.g. a no-context that triggered the handoff.
      qualityTurns: [qualityTurn({ conversationId: 'c-shared' })],
    })

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ conversationId: 'c-shared', type: 'handoff' })
  })

  it('collapses multiple low-quality turns in one conversation to its most recent', () => {
    const items = buildInboxItems({
      decisions: [],
      conversations: [],
      qualityTurns: [
        qualityTurn({ assistantMessageId: 'older', conversationId: 'c-1', createdAt: '2026-06-19T09:00:00.000Z' }),
        qualityTurn({ assistantMessageId: 'newer', conversationId: 'c-1', createdAt: '2026-06-19T11:00:00.000Z' }),
      ],
    })

    expect(items).toHaveLength(1)
    expect(items[0]?.key).toBe('quality:newer')
  })

  it('caps quality rows after conversation deduplication and reports overflow', () => {
    const turns = Array.from({ length: QUALITY_INBOX_ITEM_LIMIT + 2 }, (_, index) =>
      qualityTurn({
        assistantMessageId: `message-${index}`,
        conversationId: `conversation-${index}`,
        createdAt: new Date(Date.UTC(2026, 5, 19, 10, index)).toISOString(),
      }))
    turns.push(qualityTurn({
      assistantMessageId: 'duplicate-older',
      conversationId: 'conversation-0',
      createdAt: '2026-06-19T08:00:00.000Z',
    }))

    const model = buildInboxModel({
      decisions: [],
      conversations: [],
      qualityTurns: turns,
    })

    expect(model.items).toHaveLength(QUALITY_INBOX_ITEM_LIMIT)
    expect(new Set(model.items.map((item) => item.conversationId))).toHaveLength(QUALITY_INBOX_ITEM_LIMIT)
    expect(model.hasMoreQualityItems).toBe(true)
  })
})

describe('countNewInboxItems', () => {
  it('counts approvals and conversations that arrived after the baseline', () => {
    const baseline = inboxItemKeys([decision({ handle: 'a' })], [humanOwned({ id: 'c-1' })], [])
    const latest = inboxItemKeys(
      [decision({ handle: 'a' }), decision({ handle: 'b' })],
      [humanOwned({ id: 'c-1' }), humanOwned({ id: 'c-2' })],
      [],
    )

    expect(countNewInboxItems(baseline, latest)).toBe(2)
  })

  it('counts an updated conversation as one new item', () => {
    const baseline = inboxItemKeys([], [humanOwned({ id: 'c-1', updatedAt: '2026-06-19T10:00:00.000Z' })], [])
    const latest = inboxItemKeys([], [humanOwned({ id: 'c-1', updatedAt: '2026-06-19T10:05:00.000Z' })], [])

    expect(countNewInboxItems(baseline, latest)).toBe(1)
  })

  it('does not count removals such as a resolved approval', () => {
    const baseline = inboxItemKeys([decision({ handle: 'a' }), decision({ handle: 'b' })], [], [])
    const latest = inboxItemKeys([decision({ handle: 'a' })], [], [])

    expect(countNewInboxItems(baseline, latest)).toBe(0)
  })

  it('returns zero for an unchanged inbox', () => {
    const baseline = inboxItemKeys([decision({ handle: 'a' })], [humanOwned({ id: 'c-1' })], [])
    const latest = inboxItemKeys([decision({ handle: 'a' })], [humanOwned({ id: 'c-1' })], [])

    expect(countNewInboxItems(baseline, latest)).toBe(0)
  })
})

describe('inbox waiting durations', () => {
  it('formats minute and hour boundaries compactly', () => {
    expect(formatInboxDuration(0)).toBe('0 min')
    expect(formatInboxDuration(14 * 60_000)).toBe('14 min')
    expect(formatInboxDuration(60 * 60_000)).toBe('1 h')
    expect(formatInboxDuration(72 * 60_000)).toBe('1 h 12 min')
  })

  it('uses amber from 15 minutes and destructive from 60 minutes', () => {
    expect(waitingTone(14 * 60_000)).toBe('default')
    expect(waitingTone(15 * 60_000)).toBe('amber')
    expect(waitingTone(59 * 60_000)).toBe('amber')
    expect(waitingTone(60 * 60_000)).toBe('destructive')
  })
})
