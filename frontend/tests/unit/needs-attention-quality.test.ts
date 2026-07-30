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
  qualityApi: { listTurns: vi.fn() },
}))

const qualityApiMock = vi.mocked(qualityApi)
const turn = (overrides: Partial<LowQualityTurn> = {}): LowQualityTurn => ({
  assistantMessageId: 'message-1',
  conversationId: 'conversation-1',
  agentId: 'agent-1',
  agentName: 'Support',
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
  it('loads commented feedback, uncommented feedback, and grounding gaps as bounded partitions', async () => {
    qualityApiMock.listTurns
      .mockResolvedValueOnce(page([turn({ assistantMessageId: 'commented' })]))
      .mockResolvedValueOnce(page([turn({ assistantMessageId: 'uncommented' })]))
      .mockResolvedValueOnce(page([turn({ assistantMessageId: 'grounding' })]))

    const attempts = await loadQualityInboxSourceAttempts()

    expect(qualityApiMock.listTurns).toHaveBeenNthCalledWith(1, {
      feedback: ['down'],
      sort: 'negative_feedback_updated_at',
      activeNegativeFeedbackOnly: true,
      hasComment: true,
      limit: 25,
    })
    expect(qualityApiMock.listTurns).toHaveBeenNthCalledWith(2, {
      feedback: ['down'],
      sort: 'negative_feedback_updated_at',
      activeNegativeFeedbackOnly: true,
      hasComment: false,
      limit: 25,
    })
    expect(qualityApiMock.listTurns).toHaveBeenNthCalledWith(3, {
      signal: 'grounding_gaps',
      triageStates: ['open', 'acknowledged'],
      limit: 25,
    })
    expect(attempts.grounding.status).toBe('fulfilled')
  })

  it('still loads feedback when the grounding source fails', async () => {
    qualityApiMock.listTurns
      .mockResolvedValueOnce(page([turn({ assistantMessageId: 'commented' })]))
      .mockResolvedValueOnce(page([turn({ assistantMessageId: 'uncommented' })]))
      .mockRejectedValueOnce(new Error('grounding unavailable'))

    const attempts = await loadQualityInboxSourceAttempts()

    expect(qualityApiMock.listTurns).toHaveBeenCalledTimes(3)
    expect(attempts.commentedFeedback.status).toBe('fulfilled')
    expect(attempts.uncommentedFeedback.status).toBe('fulfilled')
    expect(attempts.grounding.status).toBe('failed')
  })
})

describe('reduceQualityInboxSnapshot', () => {
  it('merges exact duplicate turns once and reports source/global truncation', () => {
    const duplicate = turn({ assistantMessageId: 'duplicate' })
    const snapshot = reduceQualityInboxSnapshot(createEmptyQualityInboxSnapshot(), {
      commentedFeedback: { status: 'fulfilled', page: page([duplicate], 26) },
      uncommentedFeedback: { status: 'fulfilled', page: page([]) },
      grounding: { status: 'fulfilled', page: page([duplicate]) },
    })

    expect(qualityInboxPresentation(snapshot)).toMatchObject({
      turns: [duplicate],
      isTruncated: true,
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
      uncommentedFeedback: { status: 'fulfilled', page: page([]) },
      grounding: { status: 'skipped' },
    })

    const next = reduceQualityInboxSnapshot(previous, {
      commentedFeedback: { status: 'failed', error: new Error('timeout') },
      uncommentedFeedback: {
        status: 'fulfilled',
        page: page([turn({ assistantMessageId: 'fresh' })]),
      },
      grounding: { status: 'skipped' },
    })

    expect(qualityInboxPresentation(next)).toMatchObject({
      turns: [
        expect.objectContaining({ assistantMessageId: 'remembered' }),
        expect.objectContaining({ assistantMessageId: 'fresh' }),
      ],
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
      uncommentedFeedback: { status: 'fulfilled', page: page([]) },
      grounding: { status: 'skipped' },
    })

    const next = reduceQualityInboxSnapshot(previous, {
      commentedFeedback: { status: 'forbidden' },
      uncommentedFeedback: { status: 'forbidden' },
      grounding: { status: 'skipped' },
    })

    expect(qualityInboxPresentation(next)).toMatchObject({
      turns: [],
      permissionDenied: true,
      hasLoadFailure: false,
    })
  })

  it('updates and removes a turn across every source slice', () => {
    const duplicate = turn({ assistantMessageId: 'duplicate' })
    const snapshot = reduceQualityInboxSnapshot(createEmptyQualityInboxSnapshot(), {
      commentedFeedback: { status: 'fulfilled', page: page([duplicate]) },
      uncommentedFeedback: { status: 'fulfilled', page: page([]) },
      grounding: { status: 'fulfilled', page: page([duplicate]) },
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
    expect(qualityInboxPresentation(removeQualityInboxTurn(acknowledged, 'duplicate')).turns).toEqual([])
  })
})
