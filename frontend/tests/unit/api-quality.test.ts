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
      { withApiToken: true },
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
      { withApiToken: true },
    )
  })
})
