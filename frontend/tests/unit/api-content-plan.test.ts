import { afterEach, describe, expect, it, vi } from 'vitest'

const requestMock = vi.fn()

vi.mock('@/lib/api-client', () => ({
  request: requestMock,
}))

describe('content plan API', () => {
  afterEach(() => {
    requestMock.mockReset()
  })

  it('requests the default opportunities page with an authenticated workspace token', async () => {
    requestMock.mockResolvedValueOnce(emptyPage())
    const { contentPlanApi } = await import('@/lib/api-content-plan')

    await contentPlanApi.list()

    expect(requestMock).toHaveBeenCalledWith(
      '/quality/content-plan?view=opportunities',
      { method: 'GET' },
      { withApiToken: true },
    )
  })

  it('encodes the view, cursor, and limit exactly as the locked contract expects', async () => {
    requestMock.mockResolvedValueOnce(emptyPage())
    const { contentPlanApi } = await import('@/lib/api-content-plan')

    await contentPlanApi.list({ view: 'all_interests', cursor: 'opaque-abc', limit: 50 })

    expect(requestMock).toHaveBeenCalledWith(
      '/quality/content-plan?view=all_interests&cursor=opaque-abc&limit=50',
      { method: 'GET' },
      { withApiToken: true },
    )
  })

  it('fetches a topic detail by UUID', async () => {
    const topicId = '11111111-1111-4111-8111-111111111111'
    requestMock.mockResolvedValueOnce(sampleDetail(topicId))
    const { contentPlanApi } = await import('@/lib/api-content-plan')

    await contentPlanApi.getTopic(topicId)

    expect(requestMock).toHaveBeenCalledWith(
      `/quality/content-plan/topics/${topicId}`,
      { method: 'GET' },
      { withApiToken: true },
    )
  })

  it('rejects a non-UUID topic id without issuing a request', async () => {
    const { contentPlanApi } = await import('@/lib/api-content-plan')

    await expect(contentPlanApi.getTopic('not-a-uuid')).rejects.toThrow(/topic id/i)
    expect(requestMock).not.toHaveBeenCalled()
  })

  it('encodes topic member-turn requests with window, page, and pageSize', async () => {
    const topicId = '22222222-2222-4222-8222-222222222222'
    requestMock.mockResolvedValueOnce({
      items: [], total: 0, page: 2, pageSize: 50, totalPages: 0,
    })
    const { contentPlanApi } = await import('@/lib/api-content-plan')

    await contentPlanApi.listTopicTurns(topicId, { window: 'both', page: 2, pageSize: 50 })

    expect(requestMock).toHaveBeenCalledWith(
      `/quality/content-plan/topics/${topicId}/turns?window=both&page=2&pageSize=50`,
      { method: 'GET' },
      { withApiToken: true },
    )
  })

  it('defaults the member-turn window to current', async () => {
    const topicId = '33333333-3333-4333-8333-333333333333'
    requestMock.mockResolvedValueOnce({
      items: [], total: 0, page: 1, pageSize: 25, totalPages: 0,
    })
    const { contentPlanApi } = await import('@/lib/api-content-plan')

    await contentPlanApi.listTopicTurns(topicId)

    expect(requestMock).toHaveBeenCalledWith(
      `/quality/content-plan/topics/${topicId}/turns?window=current`,
      { method: 'GET' },
      { withApiToken: true },
    )
  })

  it('returns the merged canonical topic identifier from a detail response', async () => {
    const canonicalId = '44444444-4444-4444-8444-444444444444'
    const requestedId = '55555555-5555-4555-8555-555555555555'
    requestMock.mockResolvedValueOnce({
      ...sampleDetail(canonicalId),
      canonicalTopicId: canonicalId,
      redirectedFromTopicId: requestedId,
    })
    const { contentPlanApi } = await import('@/lib/api-content-plan')

    const detail = await contentPlanApi.getTopic(requestedId)

    expect(detail).not.toBeNull()
    expect(detail!.canonicalTopicId).toBe(canonicalId)
    expect(detail!.redirectedFromTopicId).toBe(requestedId)
  })

  it('surfaces 404 as null so callers can render an unknown-topic state', async () => {
    requestMock.mockRejectedValueOnce({ status: 404, error: { code: 'NOT_FOUND', message: 'nope' } })
    const { contentPlanApi } = await import('@/lib/api-content-plan')

    const detail = await contentPlanApi.getTopic('66666666-6666-4666-8666-666666666666')

    expect(detail).toBeNull()
  })

  it('rethrows non-404 errors from a detail request', async () => {
    requestMock.mockRejectedValueOnce({ status: 500, error: { code: 'HTTP_ERROR', message: 'boom' } })
    const { contentPlanApi } = await import('@/lib/api-content-plan')

    await expect(
      contentPlanApi.getTopic('77777777-7777-4777-8777-777777777777'),
    ).rejects.toMatchObject({ status: 500 })
  })
})

function emptyPage() {
  return {
    range: '30d' as const,
    window: { from: '2026-07-03T00:00:00.000Z', to: '2026-08-02T00:00:00.000Z' },
    comparisonWindow: { from: '2026-06-03T00:00:00.000Z', to: '2026-07-03T00:00:00.000Z' },
    asOf: '2026-08-02T00:00:00.000Z',
    projection: {
      state: 'ready' as const,
      processedThrough: '2026-08-02T00:00:00.000Z',
      processingLagSeconds: 0,
      pendingEmbeddingCount: 0,
      pendingAssignmentCount: 0,
      pendingEnrichmentTopicCount: 0,
      processedCount: null,
      totalCount: null,
      embeddingSpaceFingerprint: 'space-1',
      reason: null,
    },
    summary: {
      questionCount: 0,
      conversationCount: 0,
      matureTopicCount: 0,
      emergingQuestionCount: 0,
      opportunityCount: 0,
      grounding: {
        evaluatedAnswerCount: 0,
        groundedAnswerCount: 0,
        degradedAnswerCount: 0,
        noSupportAnswerCount: 0,
        notEvaluatedAnswerCount: 0,
        reducedOrNoSupportRate: null,
        headlineState: 'unmeasured' as const,
      },
    },
    rankingVersion: 1 as const,
    recommendedTopicId: null,
    items: [],
    emerging: [],
    nextCursor: null,
  }
}

function sampleDetail(topicId: string) {
  const page = emptyPage()
  return {
    asOf: page.asOf,
    window: page.window,
    comparisonWindow: page.comparisonWindow,
    projection: page.projection,
    canonicalTopicId: topicId,
    redirectedFromTopicId: null,
    topic: {
      id: topicId,
      lifecycle: 'mature' as const,
      label: 'Sample topic',
      description: null,
      labelState: 'ready' as const,
      demand: {
        currentQuestionCount: 1,
        comparisonQuestionCount: 0,
        currentConversationCount: 1,
        comparisonConversationCount: 0,
        currentShare: 1,
        absoluteChange: 1,
        trend: 'new' as const,
      },
      grounding: {
        groundedAnswerCount: 0,
        degradedAnswerCount: 0,
        noSupportAnswerCount: 0,
        notEvaluatedAnswerCount: 1,
        evaluatedAnswerCount: 0,
        reducedOrNoSupportRate: null,
        headlineState: 'unmeasured' as const,
      },
      evidence: {
        strength: 'low' as const,
        evaluatedConversationCount: 0,
        activeGapConversationCount: 0,
      },
      opportunity: { credible: false, priorityReasons: [] },
      recommendation: {
        action: null,
        state: 'pending' as const,
        rationale: null,
        suggestedTitle: null,
        questionsToAnswer: [],
        suggestedShape: null,
        evidenceStatement: null,
        factsMustBeVerified: true as const,
      },
      corpusEvidence: {
        state: 'pending' as const,
        relatedDocumentCount: 0,
        actionRuleVersion: 1 as const,
      },
      affected: { agentCount: 0, channelCount: 0 },
      updatedAt: page.asOf,
    },
    decision: { action: null, actionState: 'pending' as const, reasons: [] },
    representativeQuestions: [],
    relatedDocuments: [],
    affectedAgents: [],
    affectedChannels: [],
  }
}
