import { afterEach, describe, expect, it, vi } from 'vitest'

const requestMock = vi.fn()

vi.mock('@/lib/api-client', () => ({
  request: requestMock,
}))

describe('quality API', () => {
  afterEach(() => {
    requestMock.mockReset()
  })

  it('encodes feedback-activity ordering and active-feedback semantics', async () => {
    requestMock.mockResolvedValueOnce({
      items: [],
      total: 0,
      page: 1,
      pageSize: 25,
      totalPages: 0,
    })
    const { qualityApi } = await import('@/lib/api-quality')

    await qualityApi.listTurns({
      feedback: ['down'],
      sort: 'negative_feedback_updated_at',
      activeNegativeFeedbackOnly: true,
      hasComment: true,
      limit: 25,
    })

    expect(requestMock).toHaveBeenCalledWith(
      '/quality/turns?feedback=down&sort=negative_feedback_updated_at&activeNegativeFeedbackOnly=true&hasComment=true&limit=25',
      { method: 'GET' },
      { withSession: true },
    )
  })

  it('encodes grounding verdict and evidence-presence filters', async () => {
    requestMock.mockResolvedValueOnce({ items: [], total: 0, page: 1, pageSize: 25, totalPages: 0 })
    const { qualityApi } = await import('@/lib/api-quality')

    await qualityApi.listTurns({
      groundingVerdict: ['degraded', 'no_support'],
      hasUnsourcedClaims: true,
      hasInvalidSources: false,
    })

    expect(requestMock).toHaveBeenCalledWith(
      '/quality/turns?groundingVerdict=degraded%2Cno_support&hasUnsourcedClaims=true&hasInvalidSources=false',
      { method: 'GET' },
      { withSession: true },
    )
  })

  it('encodes structured reasons and terminal-transition windows separately from message dates', async () => {
    requestMock.mockResolvedValueOnce({ items: [], total: 0, page: 1, pageSize: 25, totalPages: 0 })
    const { qualityApi } = await import('@/lib/api-quality')

    await qualityApi.listTurns({
      resolutionReasons: ['knowledge_gap', 'other'],
      resolutionFrom: '2026-07-01T00:00:00.000Z',
      resolutionTo: '2026-08-01T00:00:00.000Z',
      from: '2026-01-01T00:00:00.000Z',
    })

    expect(requestMock).toHaveBeenCalledWith(
      '/quality/turns?resolutionReason=knowledge_gap%2Cother&from=2026-01-01T00%3A00%3A00.000Z&resolutionFrom=2026-07-01T00%3A00%3A00.000Z&resolutionTo=2026-08-01T00%3A00%3A00.000Z',
      { method: 'GET' },
      { withSession: true },
    )
  })

  it('sends the observed version and structured resolution on a terminal transition', async () => {
    requestMock.mockResolvedValueOnce({
      state: 'resolved',
      version: 3,
      resolution: { reason: 'knowledge_gap', note: null },
      legacyReason: null,
      closedAt: '2026-07-30T00:00:00.000Z',
      updatedAt: '2026-07-30T00:00:00.000Z',
    })
    const { qualityApi } = await import('@/lib/api-quality')

    await qualityApi.setTriageState('message-1', {
      state: 'resolved',
      expectedVersion: 2,
      resolution: { reason: 'knowledge_gap' },
    })

    expect(requestMock).toHaveBeenCalledWith(
      '/quality/turns/message-1/triage',
      {
        method: 'PUT',
        body: JSON.stringify({
          state: 'resolved',
          expectedVersion: 2,
          resolution: { reason: 'knowledge_gap' },
        }),
      },
      { withSession: true },
    )
  })

  it('extracts the current triage record from a canonical conflict response', async () => {
    const { getQualityTriageConflict } = await import('@/lib/api-quality')
    const current = {
      state: 'dismissed' as const,
      version: 4,
      resolution: { reason: 'expected_behavior' as const, note: null },
      legacyReason: null,
      closedAt: '2026-07-30T12:00:00.000Z',
      updatedAt: '2026-07-30T12:00:00.000Z',
    }

    expect(getQualityTriageConflict({
      status: 409,
      error: {
        code: 'QUALITY_TRIAGE_CONFLICT',
        message: 'Quality triage changed',
        details: { current },
      },
    })).toEqual(current)
  })
})
