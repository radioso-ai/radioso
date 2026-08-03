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

  it('exposes error codes from ErrorResponse-shaped throws', async () => {
    const { getAudiencePulseErrorCode } = await import('@/lib/api-audience-pulse')

    expect(getAudiencePulseErrorCode({ status: 409, error: { code: 'AUDIENCE_PULSE_REFRESH_IN_PROGRESS', message: 'busy' } }))
      .toBe('AUDIENCE_PULSE_REFRESH_IN_PROGRESS')
    expect(getAudiencePulseErrorCode(null)).toBeUndefined()
    expect(getAudiencePulseErrorCode(new Error('boom'))).toBeUndefined()
  })
})
