import { afterEach, describe, expect, it, vi } from 'vitest'

const requestMock = vi.fn()

vi.mock('@/lib/api-client', () => ({
  request: requestMock,
}))

describe('audiencePulseApi', () => {
  afterEach(() => {
    requestMock.mockReset()
  })

  it('reads via a session-authorized GET to the quality/audience-pulse endpoint', async () => {
    requestMock.mockResolvedValueOnce({ kind: 'not_generated' })

    const { audiencePulseApi } = await import('@/lib/api-audience-pulse')
    const controller = new AbortController()
    const result = await audiencePulseApi.read({ signal: controller.signal })

    expect(result).toEqual({ kind: 'not_generated' })
    expect(requestMock).toHaveBeenCalledWith(
      '/quality/audience-pulse',
      { method: 'GET', signal: controller.signal },
      { withSession: true },
    )
  })

  it('refreshes via a session-authorized POST without a body', async () => {
    requestMock.mockResolvedValueOnce({ kind: 'unavailable', reason: 'provider' })

    const { audiencePulseApi } = await import('@/lib/api-audience-pulse')
    const result = await audiencePulseApi.refresh()

    expect(result).toEqual({ kind: 'unavailable', reason: 'provider' })
    expect(requestMock).toHaveBeenCalledWith(
      '/quality/audience-pulse',
      { method: 'POST', signal: undefined },
      { withSession: true },
    )
  })

  it('loads evidence through a bounded session-authorized POST body', async () => {
    requestMock.mockResolvedValueOnce({
      conversationId: 'conversation-1',
      source: { messageId: 'message-1', role: 'user', source: 'customer', content: 'Question', createdAt: '2026-08-03T00:00:00.000Z' },
      nextAssistant: null,
    })

    const { audiencePulseApi } = await import('@/lib/api-audience-pulse')
    const result = await audiencePulseApi.getEvidenceAnchor({
      conversationId: 'conversation-1',
      messageId: 'message-1',
    })

    expect(result.conversationId).toBe('conversation-1')
    expect(requestMock).toHaveBeenCalledWith(
      '/quality/audience-pulse/evidence-anchor',
      {
        method: 'POST',
        signal: undefined,
        body: JSON.stringify({ conversationId: 'conversation-1', messageId: 'message-1' }),
      },
      { withSession: true },
    )
  })

  it('fills the topic-transition fields an API older than the browser bundle omits', async () => {
    requestMock.mockResolvedValueOnce({
      kind: 'completed',
      report: {
        period: { start: '2026-08-01T00:00:00.000Z', end: '2026-08-31T00:00:00.000Z' },
        generatedAt: '2026-08-31T09:00:00.000Z',
        coverage: { populationSize: 10, sampleSize: 10, sampled: false, facetReadyQuestionCount: 10 },
        weeklyVolume: [],
        summary: 'Most questions were about refunds.',
        themes: [{
          id: 'theme-1',
          title: 'Refund timing',
          description: 'Questions about refund timelines.',
          memberCount: 10,
          share: 1,
          distinctQuestionCount: 1,
          weeklyPulse: [],
          grounding: { grounded: 0, degraded: 0, noSupport: 0, unknown: 0, contentGapEligible: 0 },
          evidence: [],
        }],
        contentGaps: [],
        recommendations: [],
        caveats: [],
        unclassifiedQuestionCount: 0,
      },
    })

    const { audiencePulseApi } = await import('@/lib/api-audience-pulse')
    const result = await audiencePulseApi.read()

    expect(result.kind).toBe('completed')
    if (result.kind !== 'completed') return
    expect(result.report.dissolvedTopics).toEqual([])
    expect(result.report.isFirstCensus).toBe(false)
    expect(result.report.narrativeReuseCount).toBe(0)
    expect(result.report.narrativeGeneratedAt).toBe('2026-08-31T09:00:00.000Z')
    expect(result.report.narrativeReuseMaxDrift).toBeUndefined()
    expect(result.report.themes[0]).toMatchObject({
      previousMemberCount: null,
      previousShare: null,
      transition: null,
    })
  })

  it('keeps the topic-transition fields a current API sends', async () => {
    const transition = { kind: 'survived' as const, parentTopicIds: ['prior-1'], viaCentroidFallback: false }
    requestMock.mockResolvedValueOnce({
      kind: 'completed',
      report: {
        period: { start: '2026-08-01T00:00:00.000Z', end: '2026-08-31T00:00:00.000Z' },
        generatedAt: '2026-08-31T09:00:00.000Z',
        isFirstCensus: true,
        narrativeGeneratedAt: '2026-08-24T09:00:00.000Z',
        narrativeReuseCount: 2,
        narrativeReuseMaxDrift: 0.2,
        coverage: { populationSize: 10, sampleSize: 10, sampled: false, facetReadyQuestionCount: 10 },
        weeklyVolume: [],
        dissolvedTopics: [{ id: 'gone-1', title: 'Shipping delays' }],
        themes: [{
          id: 'theme-1',
          title: 'Refund timing',
          description: 'Questions about refund timelines.',
          memberCount: 10,
          previousMemberCount: 8,
          previousShare: 0.8,
          transition,
          share: 1,
          distinctQuestionCount: 1,
          weeklyPulse: [],
          grounding: { grounded: 0, degraded: 0, noSupport: 0, unknown: 0, contentGapEligible: 0 },
          evidence: [],
        }],
        contentGaps: [],
        recommendations: [],
        caveats: [],
        unclassifiedQuestionCount: 0,
      },
    })

    const { audiencePulseApi } = await import('@/lib/api-audience-pulse')
    const result = await audiencePulseApi.refresh()

    expect(result.kind).toBe('completed')
    if (result.kind !== 'completed') return
    expect(result.report.dissolvedTopics).toEqual([{ id: 'gone-1', title: 'Shipping delays' }])
    expect(result.report.isFirstCensus).toBe(true)
    expect(result.report.narrativeReuseCount).toBe(2)
    expect(result.report.narrativeReuseMaxDrift).toBe(0.2)
    expect(result.report.themes[0]).toMatchObject({
      previousMemberCount: 8,
      previousShare: 0.8,
      transition,
    })
  })

  it('exposes error codes from ErrorResponse-shaped throws', async () => {
    const { getAudiencePulseErrorCode } = await import('@/lib/api-audience-pulse')

    expect(getAudiencePulseErrorCode({ status: 409, error: { code: 'AUDIENCE_PULSE_REFRESH_IN_PROGRESS', message: 'busy' } }))
      .toBe('AUDIENCE_PULSE_REFRESH_IN_PROGRESS')
    expect(getAudiencePulseErrorCode(null)).toBeUndefined()
    expect(getAudiencePulseErrorCode(new Error('boom'))).toBeUndefined()
  })
})
