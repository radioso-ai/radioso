import { beforeEach, describe, expect, it, vi } from 'vitest'

import { qualityApi, type LowQualityTurn } from '@/lib/api'
import {
  createEmptyQualityInboxSnapshot,
  loadQualityInboxSourceAttempts,
  qualityInboxPresentation,
  reduceQualityInboxSnapshot,
  removeQualityInboxTurn,
  updateQualityInboxTurn,
} from '@/lib/needs-attention-quality'

vi.mock('@/lib/api', () => ({
  QUALITY_SIGNAL_IDS: [
    'negative_feedback',
    'grounding_gaps',
    'slow_responses',
    'skill_failures',
  ],
  qualityApi: { listTurns: vi.fn() },
}))

const qualityApiMock = vi.mocked(qualityApi)
const turn = (overrides: Partial<LowQualityTurn> = {}): LowQualityTurn => ({
  assistantMessageId: 'message-1',
  conversationId: 'conversation-1',
  agentId: 'agent-1',
  agentName: 'Support',
  agentInternalName: null,
  channel: 'authenticated_chat',
  question: 'Can I return an opened item?',
  answerPreview: 'Items can be returned within 30 days.',
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

const page = (items: LowQualityTurn[], total = items.length) => ({
  items,
  total,
  page: 1,
  pageSize: 25,
  totalPages: Math.max(1, Math.ceil(total / 25)),
})

beforeEach(() => {
  vi.clearAllMocks()
})

describe('loadQualityInboxSourceAttempts', () => {
  it('loads written feedback plus one deduplicated active-quality summary', async () => {
    qualityApiMock.listTurns
      .mockResolvedValueOnce(page([turn({ assistantMessageId: 'commented' })]))
      .mockResolvedValueOnce(page([turn({ assistantMessageId: 'review-sample' })], 14))

    const attempts = await loadQualityInboxSourceAttempts()

    expect(qualityApiMock.listTurns).toHaveBeenNthCalledWith(1, {
      feedback: ['down'],
      sort: 'negative_feedback_updated_at',
      activeNegativeFeedbackOnly: true,
      hasComment: true,
      limit: 25,
    })
    expect(qualityApiMock.listTurns).toHaveBeenNthCalledWith(2, {
      signal: [
        'negative_feedback',
        'grounding_gaps',
        'slow_responses',
        'skill_failures',
      ],
      triageStates: ['open', 'acknowledged'],
      limit: 1,
    })
    expect(qualityApiMock.listTurns).toHaveBeenCalledTimes(2)
    expect(attempts.reviewQueue.status).toBe('fulfilled')
  })

  it('can skip the aggregate query when polling only for new actionable work', async () => {
    qualityApiMock.listTurns
      .mockResolvedValueOnce(page([turn({ assistantMessageId: 'commented' })]))

    const attempts = await loadQualityInboxSourceAttempts({ includeReviewSummary: false })

    expect(qualityApiMock.listTurns).toHaveBeenCalledTimes(1)
    expect(attempts.reviewQueue.status).toBe('skipped')
  })

  it('still loads feedback when the aggregate source fails', async () => {
    qualityApiMock.listTurns
      .mockResolvedValueOnce(page([turn({ assistantMessageId: 'commented' })]))
      .mockRejectedValueOnce(new Error('quality summary unavailable'))

    const attempts = await loadQualityInboxSourceAttempts()

    expect(qualityApiMock.listTurns).toHaveBeenCalledTimes(2)
    expect(attempts.commentedFeedback.status).toBe('fulfilled')
    expect(attempts.reviewQueue.status).toBe('failed')
  })
})

describe('reduceQualityInboxSnapshot', () => {
  it('presents only written feedback and reports unique review totals separately', () => {
    const duplicate = turn({ assistantMessageId: 'duplicate' })
    const snapshot = reduceQualityInboxSnapshot(createEmptyQualityInboxSnapshot(), {
      commentedFeedback: { status: 'fulfilled', page: page([duplicate], 26) },
      reviewQueue: { status: 'fulfilled', page: page([duplicate], 41) },
    })

    expect(qualityInboxPresentation(snapshot)).toMatchObject({
      turns: [duplicate],
      reviewCount: 41,
      commentedFeedbackCount: 26,
      hasLoadFailure: false,
      permissionDenied: false,
    })
  })

  it('retains the last successful slice when one source refresh fails', () => {
    const previous = reduceQualityInboxSnapshot(createEmptyQualityInboxSnapshot(), {
      commentedFeedback: {
        status: 'fulfilled',
        page: page([turn({ assistantMessageId: 'remembered' })]),
      },
      reviewQueue: { status: 'fulfilled', page: page([], 8) },
    })

    const next = reduceQualityInboxSnapshot(previous, {
      commentedFeedback: { status: 'failed', error: new Error('timeout') },
      reviewQueue: { status: 'fulfilled', page: page([], 9) },
    })

    expect(qualityInboxPresentation(next)).toMatchObject({
      turns: [expect.objectContaining({ assistantMessageId: 'remembered' })],
      reviewCount: 9,
      hasLoadFailure: true,
      permissionDenied: false,
    })
  })

  it('clears forbidden source slices and exposes an expected permission state', () => {
    const previous = reduceQualityInboxSnapshot(createEmptyQualityInboxSnapshot(), {
      commentedFeedback: {
        status: 'fulfilled',
        page: page([turn({ assistantMessageId: 'private' })]),
      },
      reviewQueue: { status: 'fulfilled', page: page([], 1) },
    })

    const next = reduceQualityInboxSnapshot(previous, {
      commentedFeedback: { status: 'forbidden' },
      reviewQueue: { status: 'forbidden' },
    })

    expect(qualityInboxPresentation(next)).toMatchObject({
      turns: [],
      permissionDenied: true,
      hasLoadFailure: false,
    })
  })

  it('updates written feedback and decrements both totals when it leaves active review', () => {
    const duplicate = turn({ assistantMessageId: 'duplicate' })
    const snapshot = reduceQualityInboxSnapshot(createEmptyQualityInboxSnapshot(), {
      commentedFeedback: { status: 'fulfilled', page: page([duplicate]) },
      reviewQueue: {
        status: 'fulfilled',
        page: page([turn({ assistantMessageId: 'different-review-sample' })], 4),
      },
    })

    const acknowledged = updateQualityInboxTurn(snapshot, 'duplicate', (current) => ({
      ...current,
      triage: {
        state: 'acknowledged',
        version: 2,
        resolution: null,
        legacyReason: null,
        closedAt: null,
        updatedAt: '2026-06-19T10:05:00.000Z',
      },
    }))

    expect(qualityInboxPresentation(acknowledged).turns[0]?.triage.state).toBe('acknowledged')
    expect(
      qualityInboxPresentation(removeQualityInboxTurn(acknowledged, 'duplicate')),
    ).toMatchObject({
      turns: [],
      commentedFeedbackCount: 0,
      reviewCount: 3,
    })
  })
})
