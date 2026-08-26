import { afterEach, describe, expect, it, vi } from 'vitest'

const requestMock = vi.fn().mockResolvedValue({})
vi.mock('@/lib/api-client', () => ({ request: requestMock }))

describe('covered GET adapter signals', () => {
  afterEach(() => requestMock.mockClear())

  it('forwards the exact signal through documents, chat, quality, and HITL reads', async () => {
    const signal = new AbortController().signal
    const [{ documentsApi }, { chatApi }, { qualityApi }, { hitlApi }] = await Promise.all([
      import('@/lib/api-documents'),
      import('@/lib/api-chat'),
      import('@/lib/api-quality'),
      import('@/lib/api-hitl'),
    ])

    await documentsApi.listDocuments(undefined, signal)
    await chatApi.listChatHistory(undefined, signal)
    await qualityApi.getStats({}, signal)
    await hitlApi.listPendingDecisions(signal)

    expect(requestMock.mock.calls.map(([, init]) => (init as RequestInit).signal)).toEqual([
      signal,
      signal,
      signal,
      signal,
    ])
  })
})
