import { describe, expect, it } from 'vitest'

import type { ChatConversationSummary, ConversationOwnership, LowQualityTurn, PendingApprovalDecision } from '@/lib/api'
import {
  buildInboxModel,
  buildInboxItems,
  buildRecentlyClosedFeedbackItems,
  countAiHandledConversationsByAgent,
  countInboxItemsByType,
  countNewInboxItems,
  deriveInboxResponseHandoffItem,
  EMPTY_INBOX_FILTERS,
  filterInboxItems,
  findPendingApprovalDecision,
  formatInboxDuration,
  inboxItemKeys,
  inboxWaitingPresentation,
  listInboxAgents,
  listTakenByOperators,
  matchesInboxSearch,
  ownershipLabel,
  QUALITY_INBOX_ITEM_LIMIT,
  RECENTLY_CLOSED_FEEDBACK_LIMIT,
  selectHumanOwnedConversations,
  summarizeAiHandledConversations,
  TAKEN_BY_ME,
  TAKEN_BY_UNCLAIMED,
  toHandoffInboxItem,
  waitingTone,
  withinLastDays,
  type HumanOwnedConversationSummary,
  type InboxItem,
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
  agentInternalName: null,
  sourceChannel: 'authenticated_chat',
  sourceOrigin: null,
  channelContext: null,
  anonymousSessionId: null,
  entryPageUrl: null,
  title: null,
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

describe('toHandoffInboxItem', () => {
  it('maps a human-owned conversation to a handoff inbox item', () => {
    const humanOwnedConversation: HumanOwnedConversationSummary = {
      ...conversation({ id: 'conversation-handoff', preview: 'Weekly yoga schedule' }),
      ownership: ownership({ conversationId: 'conversation-handoff', version: 3, ownerAccountId: 'account-2', ownerDisplayName: 'Anna' }),
    }

    expect(toHandoffInboxItem(humanOwnedConversation)).toMatchObject({
      key: 'handoff:conversation-handoff:3',
      conversationId: 'conversation-handoff',
      type: 'handoff',
      severity: 'critical',
      title: 'Weekly yoga schedule',
      takenByAccountId: 'account-2',
      takenByDisplayName: 'Anna',
    })
  })
})

describe('deriveInboxResponseHandoffItem', () => {
  // Fixed reference instant, 5 minutes after the fixture conversations'
  // default `updatedAt` (2026-06-19T10:00:00.000Z) — inside the 10-minute
  // in-progress window used by deriveConversationOutcome.
  const now = new Date('2026-06-19T10:05:00.000Z')

  it('returns a handoff item for a conversation awaiting a human', () => {
    const awaitingHuman = conversation({
      id: 'conversation-awaiting',
      ownership: ownership({ conversationId: 'conversation-awaiting', ownerAccountId: null, ownerDisplayName: null }),
    })

    const result = deriveInboxResponseHandoffItem(awaitingHuman, now)

    expect(result).toMatchObject({ conversationId: 'conversation-awaiting', type: 'handoff' })
  })

  it('returns a handoff item for a conversation claimed by an operator', () => {
    const claimed = conversation({
      id: 'conversation-claimed',
      ownership: ownership({ conversationId: 'conversation-claimed', ownerAccountId: 'account-2', ownerDisplayName: 'Anna' }),
    })

    expect(deriveInboxResponseHandoffItem(claimed, now)?.takenByDisplayName).toBe('Anna')
  })

  it('returns an actionable item (take-over-able) for an AI-owned conversation still in progress', () => {
    // The list/detail endpoints omit `ownership` entirely for AI-owned
    // conversations, so a live one arrives with no ownership record and a
    // recent `updatedAt`. It must still be actionable — sending a reply
    // claims it, exactly like a handoff.
    const inProgress = conversation({ id: 'conversation-in-progress', updatedAt: '2026-06-19T10:00:00.000Z' })

    const result = deriveInboxResponseHandoffItem(inProgress, now)

    expect(result).toMatchObject({ conversationId: 'conversation-in-progress', type: 'handoff' })
    // No ownership record exists yet for a live, unclaimed conversation — the
    // composer's own claim-on-send flow creates it once the operator sends.
    expect(result?.takenByAccountId).toBeUndefined()
    expect(result?.takenByDisplayName).toBeUndefined()
  })

  it('returns null (read-only) for a conversation with no ownership record that has gone quiet', () => {
    const completed = conversation({ id: 'conversation-plain', updatedAt: '2026-06-19T10:00:00.000Z' })
    const wellAfterTheWindow = new Date('2026-06-19T10:20:00.000Z')

    expect(deriveInboxResponseHandoffItem(completed, wellAfterTheWindow)).toBeNull()
  })

  it('accepts a conversation known only by its detail response (no preview, no anonymousSessionId) — the All lens deep-link path', () => {
    // ChatConversationDetail (fetched independently by id, e.g. for a
    // conversation that isn't on the currently loaded list page) carries no
    // `preview` and no `anonymousSessionId`. deriveInboxResponseHandoffItem
    // must still work from that narrower shape rather than requiring a full
    // ChatConversationSummary.
    const detailShaped = {
      id: 'conversation-from-detail',
      ownership: ownership({ conversationId: 'conversation-from-detail', ownerAccountId: null, ownerDisplayName: null }),
      updatedAt: '2026-06-19T10:00:00.000Z',
      agentId: 'agent-1',
      agentName: 'Marta',
      agentInternalName: null,
    }

    const result = deriveInboxResponseHandoffItem(detailShaped, now)

    expect(result).toMatchObject({ conversationId: 'conversation-from-detail', type: 'handoff', agentName: 'Marta' })
    expect(result?.anonymousSessionId).toBeUndefined()
  })

  it('accepts a detail-shaped conversation with no ownership field, deriving from recency alone', () => {
    // Same narrow detail shape as above, but for a live AI-owned
    // conversation the detail endpoint also omits `ownership` — the
    // in-progress/completed split must still work without it.
    const detailShaped = {
      id: 'conversation-detail-in-progress',
      updatedAt: '2026-06-19T10:00:00.000Z',
      agentId: 'agent-1',
      agentName: 'Marta',
      agentInternalName: null,
    }

    expect(deriveInboxResponseHandoffItem(detailShaped, now)).toMatchObject({
      conversationId: 'conversation-detail-in-progress',
      type: 'handoff',
    })
    expect(
      deriveInboxResponseHandoffItem(detailShaped, new Date('2026-06-19T10:20:00.000Z')),
    ).toBeNull()
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

describe('findPendingApprovalDecision', () => {
  it('matches the correct decision when two pending approvals exist on the same conversation', () => {
    const first = decision({ handle: 'decision-a', conversationId: 'conversation-shared', agentId: 'agent-1', reason: 'Approve the refund' })
    const second = decision({ handle: 'decision-b', conversationId: 'conversation-shared', agentId: 'agent-1', reason: 'Approve the discount' })
    const decisions = [first, second]

    const itemForFirst: Pick<InboxItem, 'type' | 'agentId' | 'handle'> = { type: 'approval', agentId: 'agent-1', handle: 'decision-a' }
    const itemForSecond: Pick<InboxItem, 'type' | 'agentId' | 'handle'> = { type: 'approval', agentId: 'agent-1', handle: 'decision-b' }

    expect(findPendingApprovalDecision(itemForFirst, decisions)).toBe(first)
    expect(findPendingApprovalDecision(itemForSecond, decisions)).toBe(second)
  })

  it('distinguishes the same handle across different agents', () => {
    const agentOne = decision({ handle: 'decision-shared', agentId: 'agent-1', conversationId: 'conversation-1' })
    const agentTwo = decision({ handle: 'decision-shared', agentId: 'agent-2', conversationId: 'conversation-2' })

    expect(findPendingApprovalDecision({ type: 'approval', agentId: 'agent-2', handle: 'decision-shared' }, [agentOne, agentTwo])).toBe(agentTwo)
  })

  it('returns null for a non-approval item', () => {
    expect(findPendingApprovalDecision({ type: 'handoff', agentId: 'agent-1', handle: undefined }, [decision()])).toBeNull()
  })

  it('returns null when no decision matches the identity', () => {
    expect(findPendingApprovalDecision({ type: 'approval', agentId: 'agent-1', handle: 'missing' }, [decision({ handle: 'decision-1' })])).toBeNull()
  })
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

  it('includes identity-only keys for written feedback', () => {
    expect(inboxItemKeys(
      [],
      [],
      [commentedQualityTurn({ assistantMessageId: 'quality-1' })],
    )).toEqual(['quality:quality-1:down:1:comment:2026-06-19T10:05:00.000Z'])
  })

  it('adds a quality key only when a down-vote gains a written comment', () => {
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

    expect(before).toEqual([])
    expect(afterVote).toEqual([])
    expect(afterComment).not.toEqual(afterVote)
  })

  it('omits a quality key when the same conversation has a critical escalation', () => {
    expect(inboxItemKeys(
      [decision({ conversationId: 'shared-conversation' })],
      [],
      [commentedQualityTurn({ conversationId: 'shared-conversation' })],
    )).toEqual([`approval:agent-1:decision-1`])
  })
})

const qualityTurn = (overrides: Partial<LowQualityTurn> = {}): LowQualityTurn => ({
  assistantMessageId: 'message-1',
  conversationId: 'conversation-q1',
  agentId: 'agent-1',
  agentName: 'Marta',
  agentInternalName: null,
  channel: 'authenticated_chat',
  question: 'What is your refund policy?',
  answerPreview: 'I could not find that in the documents.',
  skillName: 'retrieval.answer',
  skillOutcome: 'no_context',
  skillStatus: 'completed',
  totalLatencyMs: 1200,
  grounding: null,
  createdAt: '2026-06-19T10:00:00.000Z',
  feedback: {
    upCount: 0,
    downCount: 0,
    latestDownUpdatedAt: null,
    comments: [],
  },
  triage: {
    state: 'open',
    version: 0,
    resolution: null,
    legacyReason: null,
    closedAt: null,
    updatedAt: null,
  },
  verification: null,
  ...overrides,
})

const commentedQualityTurn = (
  overrides: Partial<LowQualityTurn> = {},
  feedbackUpdatedAt = '2026-06-19T10:05:00.000Z',
): LowQualityTurn => qualityTurn({
  ...overrides,
  feedback: {
    upCount: 0,
    downCount: 1,
    latestDownUpdatedAt: feedbackUpdatedAt,
    comments: [{
      value: 'down',
      comment: 'This misses the documented exception.',
      createdAt: feedbackUpdatedAt,
      updatedAt: feedbackUpdatedAt,
    }],
  },
})

describe('buildInboxItems', () => {
  it('excludes automatic signals and uncommented feedback from operator attention', () => {
    const items = buildInboxItems({
      decisions: [],
      conversations: [],
      qualityTurns: [
        qualityTurn({
          assistantMessageId: 'automatic-no-context',
          skillOutcome: 'no_context',
        }),
        qualityTurn({
          assistantMessageId: 'uncommented-feedback',
          feedback: {
            upCount: 0,
            downCount: 1,
            latestDownUpdatedAt: '2026-06-19T10:05:00.000Z',
            comments: [],
          },
        }),
      ],
    })

    expect(items).toEqual([])
  })

  it('tags actionable sources and excludes passive signals', () => {
    const items = buildInboxItems({
      decisions: [decision({ handle: 'd1', conversationId: 'c-approval' })],
      conversations: [humanOwned({ id: 'c-handoff' })],
      qualityTurns: [
        commentedQualityTurn({
          assistantMessageId: 'm-feedback',
          conversationId: 'c-feedback',
        }),
        qualityTurn({ assistantMessageId: 'm-deg', conversationId: 'c-deg', skillOutcome: 'grounded_degraded' }),
        qualityTurn({ assistantMessageId: 'm-noctx', conversationId: 'c-noctx', skillOutcome: 'no_context' }),
      ],
    })

    const byConversation = Object.fromEntries(items.map((item) => [item.conversationId, item]))
    expect(byConversation['c-approval']).toMatchObject({ type: 'approval', severity: 'critical' })
    expect(byConversation['c-handoff']).toMatchObject({ type: 'handoff', severity: 'critical' })
    expect(byConversation['c-feedback']).toMatchObject({
      type: 'negative_feedback',
      severity: 'feedback',
      assistantMessageId: 'm-feedback',
      triage: { state: 'open', version: 0 },
    })
    expect(byConversation['c-deg']).toBeUndefined()
    expect(byConversation['c-noctx']).toBeUndefined()
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
            version: 1,
            resolution: null,
            legacyReason: null,
            closedAt: null,
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

  it('orders critical escalations above written feedback', () => {
    const items = buildInboxItems({
      decisions: [decision({ handle: 'd1', conversationId: 'c-approval' })],
      conversations: [humanOwned({ id: 'c-handoff' })],
      qualityTurns: [commentedQualityTurn({ conversationId: 'c-quality' })],
    })

    const severities = items.map((item) => item.severity)
    expect(severities).toEqual(['critical', 'critical', 'feedback'])
  })

  it('orders written feedback below blocking work and drops passive quality signals', () => {
    const items = buildInboxItems({
      decisions: [decision({ conversationId: 'approval' })],
      conversations: [],
      qualityTurns: [
        qualityTurn({
          assistantMessageId: 'passive-newer',
          conversationId: 'passive',
          createdAt: '2026-06-19T12:00:00.000Z',
        }),
        commentedQualityTurn({
          assistantMessageId: 'feedback-older',
          conversationId: 'feedback',
          createdAt: '2026-06-19T09:00:00.000Z',
        }, '2026-06-19T09:05:00.000Z'),
      ],
    })

    expect(items.map((item) => item.conversationId)).toEqual(['approval', 'feedback'])
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
    ])
  })

  it('orders equal-priority feedback by feedback activity instead of answer creation time', () => {
    const items = buildInboxItems({
      decisions: [],
      conversations: [],
      qualityTurns: [
        commentedQualityTurn({
          assistantMessageId: 'new-answer-old-feedback',
          conversationId: 'new-answer',
          createdAt: '2026-06-19T12:00:00.000Z',
        }, '2026-06-19T12:05:00.000Z'),
        commentedQualityTurn({
          assistantMessageId: 'old-answer-fresh-feedback',
          conversationId: 'old-answer',
          createdAt: '2026-01-01T08:00:00.000Z',
        }, '2026-06-20T09:00:00.000Z'),
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
        commentedQualityTurn({
          assistantMessageId: 'new-answer-old-feedback',
          conversationId: 'shared-conversation',
          createdAt: '2026-06-19T12:00:00.000Z',
        }, '2026-06-19T12:05:00.000Z'),
        commentedQualityTurn({
          assistantMessageId: 'old-answer-fresh-feedback',
          conversationId: 'shared-conversation',
          createdAt: '2026-01-01T08:00:00.000Z',
        }, '2026-06-20T09:00:00.000Z'),
      ],
    })

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      assistantMessageId: 'old-answer-fresh-feedback',
      timestamp: '2026-06-20T09:00:00.000Z',
    })
  })

  it('orders critical items oldest-first while keeping written feedback newest-first below them', () => {
    const items = buildInboxItems({
      decisions: [decision({ conversationId: 'approval-newer', createdAt: '2026-06-19T11:00:00.000Z' })],
      conversations: [humanOwned({
        id: 'handoff-older',
        ownership: ownership({ updatedAt: '2026-06-19T09:00:00.000Z' }),
      })],
      qualityTurns: [
        commentedQualityTurn(
          { conversationId: 'quality-older', createdAt: '2026-06-19T08:00:00.000Z' },
          '2026-06-19T08:05:00.000Z',
        ),
        commentedQualityTurn(
          { conversationId: 'quality-newer', createdAt: '2026-06-19T12:00:00.000Z' },
          '2026-06-19T12:05:00.000Z',
        ),
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
      qualityTurns: [commentedQualityTurn({ conversationId: 'c-shared' })],
    })

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ conversationId: 'c-shared', type: 'handoff' })
  })

  it('collapses multiple written-feedback turns in one conversation to its freshest feedback', () => {
    const items = buildInboxItems({
      decisions: [],
      conversations: [],
      qualityTurns: [
        commentedQualityTurn(
          { assistantMessageId: 'older', conversationId: 'c-1' },
          '2026-06-19T09:00:00.000Z',
        ),
        commentedQualityTurn(
          { assistantMessageId: 'newer', conversationId: 'c-1' },
          '2026-06-19T11:00:00.000Z',
        ),
      ],
    })

    expect(items).toHaveLength(1)
    expect(items[0]?.key).toBe('quality:newer')
  })

  it('caps written-feedback rows after conversation deduplication', () => {
    const turns = Array.from({ length: QUALITY_INBOX_ITEM_LIMIT + 2 }, (_, index) =>
      commentedQualityTurn(
        {
          assistantMessageId: `message-${index}`,
          conversationId: `conversation-${index}`,
        },
        new Date(Date.UTC(2026, 5, 19, 10, index)).toISOString(),
      ))
    turns.push(commentedQualityTurn(
      {
        assistantMessageId: 'duplicate-older',
        conversationId: 'conversation-0',
      },
      '2026-06-19T08:00:00.000Z',
    ))

    const model = buildInboxModel({
      decisions: [],
      conversations: [],
      qualityTurns: turns,
    })

    expect(model.items).toHaveLength(QUALITY_INBOX_ITEM_LIMIT)
    expect(new Set(model.items.map((item) => item.conversationId))).toHaveLength(QUALITY_INBOX_ITEM_LIMIT)
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

describe('inboxWaitingPresentation', () => {
  const now = new Date('2026-06-19T12:00:00.000Z')

  it('shows a relative time for feedback items', () => {
    const items = buildInboxItems({
      decisions: [],
      conversations: [],
      qualityTurns: [commentedQualityTurn({}, '2026-06-19T10:00:00.000Z')],
    })

    expect(inboxWaitingPresentation(items[0], now)).toEqual({ label: '2 hours ago', tone: 'default' })
  })

  it('shows "waiting" with escalating tone for an unclaimed handoff', () => {
    const items = buildInboxItems({
      decisions: [],
      conversations: [humanOwned({ ownership: ownership({ updatedAt: '2026-06-19T11:40:00.000Z' }) })],
      qualityTurns: [],
    })

    expect(inboxWaitingPresentation(items[0], now)).toEqual({ label: 'waiting 20 min', tone: 'amber' })
  })

  it('shows "with them" and a neutral tone once a handoff is taken over', () => {
    const items = buildInboxItems({
      decisions: [],
      conversations: [humanOwned({
        ownership: ownership({
          ownerAccountId: 'account-anna',
          ownerDisplayName: 'Anna',
          takenOverAt: '2026-06-19T11:55:00.000Z',
        }),
      })],
      qualityTurns: [],
    })

    expect(inboxWaitingPresentation(items[0], now)).toEqual({ label: 'with them 5 min', tone: 'default' })
  })
})

describe('inbox item last-message time and taken-by', () => {
  it('uses the conversation updatedAt as the handoff last-message time', () => {
    const items = buildInboxItems({
      decisions: [],
      conversations: [humanOwned({ id: 'c-1', updatedAt: '2026-06-19T11:30:00.000Z' })],
      qualityTurns: [],
    })

    expect(items[0]).toMatchObject({ lastMessageAt: '2026-06-19T11:30:00.000Z' })
  })

  it('leaves approvals without a last-message time', () => {
    const items = buildInboxItems({
      decisions: [decision({ conversationId: 'c-approval' })],
      conversations: [],
      qualityTurns: [],
    })

    expect(items[0]).toMatchObject({ lastMessageAt: null })
  })

  it('uses the answer turn createdAt as the feedback last-message proxy', () => {
    const items = buildInboxItems({
      decisions: [],
      conversations: [],
      qualityTurns: [commentedQualityTurn({ createdAt: '2026-06-19T09:15:00.000Z' })],
    })

    expect(items[0]).toMatchObject({ lastMessageAt: '2026-06-19T09:15:00.000Z' })
  })

  it('marks an unclaimed handoff with a null taken-by account', () => {
    const items = buildInboxItems({
      decisions: [],
      conversations: [humanOwned({ ownership: ownership({ ownerAccountId: null, ownerDisplayName: null }) })],
      qualityTurns: [],
    })

    expect(items[0]).toMatchObject({ takenByAccountId: null })
  })

  it('carries the claimant onto a taken handoff', () => {
    const items = buildInboxItems({
      decisions: [],
      conversations: [humanOwned({
        ownership: ownership({ ownerAccountId: 'account-2', ownerDisplayName: 'Ada Lovelace' }),
      })],
      qualityTurns: [],
    })

    expect(items[0]).toMatchObject({ takenByAccountId: 'account-2', takenByDisplayName: 'Ada Lovelace' })
  })

  it('carries the anonymous session id onto a handoff item', () => {
    const items = buildInboxItems({
      decisions: [],
      conversations: [humanOwned({ anonymousSessionId: 'session-1' })],
      qualityTurns: [],
    })

    expect(items[0]).toMatchObject({ anonymousSessionId: 'session-1' })
  })

  it('leaves approvals and feedback without a known session state', () => {
    const items = buildInboxItems({
      decisions: [decision({ conversationId: 'c-approval' })],
      conversations: [],
      qualityTurns: [commentedQualityTurn({ conversationId: 'c-feedback' })],
    })

    for (const item of items) {
      expect(item.anonymousSessionId).toBeUndefined()
    }
  })

  it('leaves approvals and feedback without a taken-by concept', () => {
    const items = buildInboxItems({
      decisions: [decision({ conversationId: 'c-approval' })],
      conversations: [],
      qualityTurns: [commentedQualityTurn({ conversationId: 'c-feedback' })],
    })

    for (const item of items) {
      expect(item.takenByAccountId).toBeUndefined()
    }
  })
})

describe('matchesInboxSearch', () => {
  const item = (title: string): InboxItem => ({
    key: 'k',
    conversationId: 'c-1',
    type: 'handoff',
    severity: 'critical',
    title,
    detail: '',
    timestamp: '2026-06-19T10:00:00.000Z',
  })

  it('matches everything on an empty or whitespace-only query', () => {
    expect(matchesInboxSearch(item('Weekly yoga schedule'), '')).toBe(true)
    expect(matchesInboxSearch(item('Weekly yoga schedule'), '   ')).toBe(true)
  })

  it('matches case-insensitively against the gist title', () => {
    expect(matchesInboxSearch(item('Weekly yoga schedule'), 'YOGA')).toBe(true)
    expect(matchesInboxSearch(item('Weekly yoga schedule'), 'refund')).toBe(false)
  })
})

describe('filterInboxItems', () => {
  const context = { currentAccountId: 'account-me' }

  it('filters by item type', () => {
    const items = buildInboxItems({
      decisions: [decision({ conversationId: 'c-approval' })],
      conversations: [humanOwned({ id: 'c-handoff' })],
      qualityTurns: [],
    })

    const filtered = filterInboxItems(items, { ...EMPTY_INBOX_FILTERS, type: 'approval' }, context)

    expect(filtered.map((i) => i.conversationId)).toEqual(['c-approval'])
  })

  it('filters by agent', () => {
    const items = buildInboxItems({
      decisions: [],
      conversations: [
        humanOwned({ id: 'c-a', agentId: 'agent-a' }),
        humanOwned({ id: 'c-b', agentId: 'agent-b', ownership: ownership({ conversationId: 'c-b' }) }),
      ],
      qualityTurns: [],
    })

    const filtered = filterInboxItems(items, { ...EMPTY_INBOX_FILTERS, agentId: 'agent-b' }, context)

    expect(filtered.map((i) => i.conversationId)).toEqual(['c-b'])
  })

  it('filters by search text', () => {
    const items = buildInboxItems({
      decisions: [decision({ conversationId: 'c-approval', reason: 'Apply a goodwill discount' })],
      conversations: [humanOwned({ id: 'c-handoff', preview: 'Weekly yoga schedule' })],
      qualityTurns: [],
    })

    const filtered = filterInboxItems(items, { ...EMPTY_INBOX_FILTERS, search: 'yoga' }, context)

    expect(filtered.map((i) => i.conversationId)).toEqual(['c-handoff'])
  })

  it('taken-by anyone includes unclaimed handoffs, approvals, and feedback', () => {
    const items = buildInboxItems({
      decisions: [decision({ conversationId: 'c-approval' })],
      conversations: [humanOwned({ id: 'c-handoff' })],
      qualityTurns: [commentedQualityTurn({ conversationId: 'c-feedback' })],
    })

    expect(filterInboxItems(items, EMPTY_INBOX_FILTERS, context)).toHaveLength(3)
  })

  it('taken-by unclaimed excludes claimed handoffs and non-ownership item types', () => {
    const items = buildInboxItems({
      decisions: [decision({ conversationId: 'c-approval' })],
      conversations: [
        humanOwned({ id: 'c-unclaimed' }),
        humanOwned({
          id: 'c-claimed',
          ownership: ownership({ conversationId: 'c-claimed', ownerAccountId: 'account-other', ownerDisplayName: 'Anna' }),
        }),
      ],
      qualityTurns: [commentedQualityTurn({ conversationId: 'c-feedback' })],
    })

    const filtered = filterInboxItems(items, { ...EMPTY_INBOX_FILTERS, takenBy: TAKEN_BY_UNCLAIMED }, context)

    expect(filtered.map((i) => i.conversationId)).toEqual(['c-unclaimed'])
  })

  it('taken-by me matches only the current operator\'s claims', () => {
    const items = buildInboxItems({
      decisions: [],
      conversations: [
        humanOwned({
          id: 'c-mine',
          ownership: ownership({ conversationId: 'c-mine', ownerAccountId: 'account-me', ownerDisplayName: 'Me' }),
        }),
        humanOwned({
          id: 'c-theirs',
          ownership: ownership({ conversationId: 'c-theirs', ownerAccountId: 'account-other', ownerDisplayName: 'Anna' }),
        }),
      ],
      qualityTurns: [],
    })

    const filtered = filterInboxItems(items, { ...EMPTY_INBOX_FILTERS, takenBy: TAKEN_BY_ME }, context)

    expect(filtered.map((i) => i.conversationId)).toEqual(['c-mine'])
  })

  it('taken-by a specific operator id matches only that claimant', () => {
    const items = buildInboxItems({
      decisions: [],
      conversations: [
        humanOwned({
          id: 'c-anna',
          ownership: ownership({ conversationId: 'c-anna', ownerAccountId: 'account-anna', ownerDisplayName: 'Anna' }),
        }),
        humanOwned({
          id: 'c-other',
          ownership: ownership({ conversationId: 'c-other', ownerAccountId: 'account-other', ownerDisplayName: 'Someone' }),
        }),
      ],
      qualityTurns: [],
    })

    const filtered = filterInboxItems(items, { ...EMPTY_INBOX_FILTERS, takenBy: 'account-anna' }, context)

    expect(filtered.map((i) => i.conversationId)).toEqual(['c-anna'])
  })

  it('combines filters', () => {
    const items = buildInboxItems({
      decisions: [decision({ conversationId: 'c-approval', reason: 'Apply a goodwill discount' })],
      conversations: [humanOwned({ id: 'c-handoff', preview: 'Weekly yoga schedule' })],
      qualityTurns: [],
    })

    expect(filterInboxItems(items, { ...EMPTY_INBOX_FILTERS, type: 'approval', search: 'yoga' }, context)).toEqual([])
  })
})

describe('countInboxItemsByType', () => {
  it('counts each type plus a total', () => {
    const items = buildInboxItems({
      decisions: [decision({ handle: 'd1', conversationId: 'c-approval' })],
      conversations: [humanOwned({ id: 'c-handoff' })],
      qualityTurns: [commentedQualityTurn({ conversationId: 'c-feedback' })],
    })

    expect(countInboxItemsByType(items)).toEqual({
      all: 3,
      approval: 1,
      handoff: 1,
      negative_feedback: 1,
    })
  })

  it('returns all zeros for an empty queue', () => {
    expect(countInboxItemsByType([])).toEqual({ all: 0, approval: 0, handoff: 0, negative_feedback: 0 })
  })
})

describe('listInboxAgents', () => {
  it('deduplicates agents across item types in first-seen order', () => {
    const items = buildInboxItems({
      decisions: [],
      conversations: [
        humanOwned({ id: 'c-1', agentId: 'agent-1', agentName: 'Marta' }),
        humanOwned({
          id: 'c-2',
          agentId: 'agent-1',
          agentName: 'Marta',
          ownership: ownership({ conversationId: 'c-2' }),
        }),
      ],
      qualityTurns: [commentedQualityTurn({ conversationId: 'c-3', agentId: 'agent-2', agentName: 'Support' })],
    })

    expect(listInboxAgents(items)).toEqual([
      { agentId: 'agent-1', agentName: 'Marta', agentInternalName: null },
      { agentId: 'agent-2', agentName: 'Support', agentInternalName: null },
    ])
  })
})

describe('listTakenByOperators', () => {
  it('deduplicates operators and falls back to a teammate label', () => {
    const items = buildInboxItems({
      decisions: [],
      conversations: [
        humanOwned({
          id: 'c-1',
          ownership: ownership({ conversationId: 'c-1', ownerAccountId: 'account-anna', ownerDisplayName: 'Anna' }),
        }),
        humanOwned({
          id: 'c-2',
          ownership: ownership({ conversationId: 'c-2', ownerAccountId: 'account-anna', ownerDisplayName: 'Anna' }),
        }),
        humanOwned({
          id: 'c-3',
          ownership: ownership({ conversationId: 'c-3', ownerAccountId: 'account-x', ownerDisplayName: null }),
        }),
      ],
      qualityTurns: [],
    })

    expect(listTakenByOperators(items)).toEqual([
      { accountId: 'account-anna', displayName: 'Anna' },
      { accountId: 'account-x', displayName: 'A teammate' },
    ])
  })
})

describe('buildRecentlyClosedFeedbackItems', () => {
  const closedTurn = (overrides: Partial<LowQualityTurn> = {}): LowQualityTurn => ({
    assistantMessageId: 'message-1',
    conversationId: 'conversation-1',
    agentId: 'agent-1',
    agentName: 'Marta',
    agentInternalName: null,
    channel: 'authenticated_chat',
    question: 'What is your refund policy?',
    answerPreview: 'I could not find that in the documents.',
    skillName: 'retrieval.answer',
    skillOutcome: 'no_context',
    skillStatus: 'completed',
    totalLatencyMs: 1200,
    grounding: null,
    createdAt: '2026-06-19T10:00:00.000Z',
    feedback: { upCount: 0, downCount: 1, latestDownUpdatedAt: null, comments: [] },
    triage: {
      state: 'resolved',
      version: 1,
      resolution: null,
      legacyReason: null,
      closedAt: '2026-06-19T11:00:00.000Z',
      updatedAt: '2026-06-19T11:00:00.000Z',
    },
    verification: null,
    ...overrides,
  })

  it('keeps only resolved and dismissed turns', () => {
    const items = buildRecentlyClosedFeedbackItems([
      closedTurn({ assistantMessageId: 'open', triage: { state: 'open', version: 0, resolution: null, legacyReason: null, closedAt: null, updatedAt: null } }),
      closedTurn({ assistantMessageId: 'resolved' }),
      closedTurn({ assistantMessageId: 'dismissed', triage: { state: 'dismissed', version: 1, resolution: null, legacyReason: null, closedAt: '2026-06-19T12:00:00.000Z', updatedAt: '2026-06-19T12:00:00.000Z' } }),
    ])

    expect(items.map((i) => i.key)).toEqual(['quality:dismissed', 'quality:resolved'])
  })

  it('sorts newest closure first', () => {
    const items = buildRecentlyClosedFeedbackItems([
      closedTurn({
        assistantMessageId: 'older',
        triage: { state: 'resolved', version: 1, resolution: null, legacyReason: null, closedAt: '2026-06-19T09:00:00.000Z', updatedAt: '2026-06-19T09:00:00.000Z' },
      }),
      closedTurn({
        assistantMessageId: 'newer',
        triage: { state: 'resolved', version: 1, resolution: null, legacyReason: null, closedAt: '2026-06-19T15:00:00.000Z', updatedAt: '2026-06-19T15:00:00.000Z' },
      }),
    ])

    expect(items.map((i) => i.key)).toEqual(['quality:newer', 'quality:older'])
  })

  it('caps the strip length', () => {
    const turns = Array.from({ length: RECENTLY_CLOSED_FEEDBACK_LIMIT + 3 }, (_, index) =>
      closedTurn({
        assistantMessageId: `message-${index}`,
        triage: {
          state: 'resolved',
          version: 1,
          resolution: null,
          legacyReason: null,
          closedAt: new Date(Date.UTC(2026, 5, 19, 10, index)).toISOString(),
          updatedAt: new Date(Date.UTC(2026, 5, 19, 10, index)).toISOString(),
        },
      }))

    expect(buildRecentlyClosedFeedbackItems(turns)).toHaveLength(RECENTLY_CLOSED_FEEDBACK_LIMIT)
  })
})

describe('withinLastDays', () => {
  const now = new Date('2026-06-19T12:00:00.000Z')

  it('includes a timestamp exactly at the window boundary', () => {
    expect(withinLastDays('2026-06-12T12:00:00.000Z', 7, now)).toBe(true)
  })

  it('excludes a timestamp just past the window', () => {
    expect(withinLastDays('2026-06-12T11:59:59.000Z', 7, now)).toBe(false)
  })

  it('excludes an unparseable timestamp', () => {
    expect(withinLastDays('not-a-date', 7, now)).toBe(false)
  })
})

describe('countAiHandledConversationsByAgent', () => {
  it('counts conversations never escalated to a human, per agent', () => {
    const counts = countAiHandledConversationsByAgent([
      conversation({ id: 'c-1', agentId: 'agent-1', agentName: 'Gioia' }),
      conversation({ id: 'c-2', agentId: 'agent-1', agentName: 'Gioia' }),
      conversation({ id: 'c-3', agentId: 'agent-2', agentName: 'Claudio' }),
      conversation({ id: 'c-4', agentId: 'agent-1', agentName: 'Gioia', ownership: ownership({ conversationId: 'c-4' }) }),
    ])

    expect(counts).toEqual([
      { agentId: 'agent-1', agentName: 'Gioia', agentInternalName: null, count: 2 },
      { agentId: 'agent-2', agentName: 'Claudio', agentInternalName: null, count: 1 },
    ])
  })

  it('excludes conversations handed to a human', () => {
    const counts = countAiHandledConversationsByAgent([
      conversation({
        id: 'c-1',
        agentId: 'agent-1',
        ownership: ownership({
          conversationId: 'c-1',
          state: 'human_owned',
          ownerAccountId: 'account-1',
          ownerDisplayName: 'Anna',
        }),
      }),
    ])

    expect(counts).toEqual([])
  })
})

describe('summarizeAiHandledConversations', () => {
  it('rolls up a single agent as singular ("agent")', () => {
    expect(summarizeAiHandledConversations([
      conversation({ id: 'c-1', agentId: 'agent-1', agentName: 'Gioia' }),
      conversation({ id: 'c-2', agentId: 'agent-1', agentName: 'Gioia' }),
    ])).toEqual({ totalCount: 2, agentCount: 1 })
  })

  it('sums across every agent as plural ("agents") — the Inbox speaks for the workspace, not one named agent', () => {
    expect(summarizeAiHandledConversations([
      conversation({ id: 'c-1', agentId: 'agent-1', agentName: 'Gioia' }),
      conversation({ id: 'c-2', agentId: 'agent-1', agentName: 'Gioia' }),
      conversation({ id: 'c-3', agentId: 'agent-2', agentName: 'Claudio' }),
    ])).toEqual({ totalCount: 3, agentCount: 2 })
  })

  it('excludes conversations handed to a human from the total', () => {
    expect(summarizeAiHandledConversations([
      conversation({ id: 'c-1', agentId: 'agent-1' }),
      conversation({
        id: 'c-2',
        agentId: 'agent-1',
        ownership: ownership({ conversationId: 'c-2', state: 'human_owned', ownerAccountId: 'account-1', ownerDisplayName: 'Anna' }),
      }),
    ])).toEqual({ totalCount: 1, agentCount: 1 })
  })

  it('returns zero counts for an empty or fully-escalated window', () => {
    expect(summarizeAiHandledConversations([])).toEqual({ totalCount: 0, agentCount: 0 })
  })
})
