import { afterEach, describe, expect, it, vi } from 'vitest'

const requestMock = vi.fn()

vi.mock('@/lib/api-client', () => ({
  request: requestMock,
}))

describe('hitlApi', () => {
  afterEach(() => {
    requestMock.mockReset()
  })

  it('lists pending decisions', async () => {
    requestMock.mockResolvedValueOnce({ decisions: [] })

    const { hitlApi } = await import('@/lib/api-hitl')

    await expect(hitlApi.listPendingDecisions()).resolves.toEqual({ decisions: [] })
    expect(requestMock).toHaveBeenCalledWith('/decisions', { method: 'GET' }, { withApiToken: true })
  })

  it('resolves a decision with agent, handle, and body', async () => {
    const response = {
      status: 'resolved',
      optionId: 'approve',
      conversationId: 'conversation-1',
      resumed: true,
    }
    const body = {
      optionId: 'approve',
      payload: { note: 'Looks good' },
      contentHash: 'hash-1',
    }
    requestMock.mockResolvedValueOnce(response)

    const { hitlApi } = await import('@/lib/api-hitl')

    await expect(hitlApi.resolveDecision('agent/1', 'handle/1', body)).resolves.toEqual(response)
    expect(requestMock).toHaveBeenCalledWith(
      '/agents/agent%2F1/decisions/handle%2F1/resolve',
      { method: 'POST', body: JSON.stringify(body) },
      { withApiToken: true },
    )
  })

  it('takes over, replies, transfers, and hands back conversations', async () => {
    const ownershipResponse = { ownership: { conversationId: 'conversation-1', version: 2 } }
    const replyResponse = { message: { id: 'message-1' } }
    requestMock
      .mockResolvedValueOnce(ownershipResponse)
      .mockResolvedValueOnce(replyResponse)
      .mockResolvedValueOnce(ownershipResponse)
      .mockResolvedValueOnce(ownershipResponse)

    const { hitlApi } = await import('@/lib/api-hitl')

    await hitlApi.takeOverConversation('conversation/1', { reason: 'Needs review' })
    await hitlApi.replyAsHuman('conversation/1', { message: 'Human reply', expectedVersion: 2 })
    await hitlApi.transferConversation('conversation/1', { toAccountId: 'account-2', expectedVersion: 3 })
    await hitlApi.handBackConversation('conversation/1', { expectedVersion: 4 })

    expect(requestMock).toHaveBeenNthCalledWith(
      1,
      '/conversations/conversation%2F1/takeover',
      { method: 'POST', body: JSON.stringify({ reason: 'Needs review' }) },
      { withApiToken: true },
    )
    expect(requestMock).toHaveBeenNthCalledWith(
      2,
      '/conversations/conversation%2F1/reply',
      { method: 'POST', body: JSON.stringify({ message: 'Human reply', expectedVersion: 2 }) },
      { withApiToken: true },
    )
    expect(requestMock).toHaveBeenNthCalledWith(
      3,
      '/conversations/conversation%2F1/transfer',
      { method: 'POST', body: JSON.stringify({ toAccountId: 'account-2', expectedVersion: 3 }) },
      { withApiToken: true },
    )
    expect(requestMock).toHaveBeenNthCalledWith(
      4,
      '/conversations/conversation%2F1/handback',
      { method: 'POST', body: JSON.stringify({ expectedVersion: 4 }) },
      { withApiToken: true },
    )
  })

  it('tails a conversation with optional query params', async () => {
    const response = { messages: [], cursor: 'cursor-2' }
    requestMock.mockResolvedValueOnce(response)

    const { hitlApi } = await import('@/lib/api-hitl')

    await expect(hitlApi.tailConversation('conversation/1', { cursor: 'cursor-1', limit: 25 })).resolves.toEqual(response)
    expect(requestMock).toHaveBeenCalledWith(
      '/history/chat/conversation%2F1/tail?cursor=cursor-1&limit=25',
      { method: 'GET' },
      { withApiToken: true },
    )
  })

  it('surfaces 409 and 422 request errors as detectable HITL status errors', async () => {
    const conflict = { status: 409, error: { code: 'CONFLICT', message: 'Stale version' } }
    const invalidOption = { status: 422, error: { code: 'INVALID_OPTION', message: 'Invalid option' } }

    const { getHitlApiErrorStatus, hitlApi, isHitlApiStatusError } = await import('@/lib/api-hitl')

    requestMock.mockRejectedValueOnce(conflict)
    await expect(hitlApi.replyAsHuman('conversation-1', { message: 'Reply', expectedVersion: 1 })).rejects.toBe(conflict)
    expect(getHitlApiErrorStatus(conflict)).toBe(409)
    expect(isHitlApiStatusError(conflict, 409)).toBe(true)

    requestMock.mockRejectedValueOnce(invalidOption)
    await expect(hitlApi.resolveDecision('agent-1', 'decision-1', {
      optionId: 'missing',
      contentHash: 'hash-1',
    })).rejects.toBe(invalidOption)
    expect(getHitlApiErrorStatus(invalidOption)).toBe(422)
    expect(isHitlApiStatusError(invalidOption, 422)).toBe(true)
  })
})
