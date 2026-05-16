import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api-client', () => ({
  API_BASE: '/backend/api/v1',
  PUBLIC_CHAT_STREAMING_API_PATH: '/backend/api/v1/public/chat',
  STREAMING_API_PATH: '/backend/api/v1/assistant/chat',
  attachAnonymousSessionHeader: (_token: string, headers: Record<string, string>) => headers,
  buildError: async () => ({ error: { code: 'HTTP_ERROR', message: 'Request failed.' } }),
  canRetryWithFreshWorkspaceToken: () => false,
  persistAnonymousSessionHeader: vi.fn(),
  refreshWorkspaceApiToken: vi.fn(),
  request: vi.fn(),
  requestLongRunning: vi.fn(),
  requireWorkspaceApiToken: async () => 'workspace-token',
  storePublicSessionToken: vi.fn(),
  storeWorkspaceToken: vi.fn(),
}))

const bootstrapPayload = {
  route: {
    type: 'direct',
    reason: 'conversation_start',
  },
  answer: 'Hello, how can I help?',
  citations: [],
  answerSegments: [{ text: 'Hello, how can I help?' }],
  activitySummary: {
    retrievalSkipped: true,
  },
  activityTrace: {
    traceId: 'trace-1',
    startedAt: '2026-05-05T10:00:00.000Z',
    stages: [],
    links: [],
  },
}

const turnPayload = {
  ...bootstrapPayload,
  conversationId: '11111111-1111-4111-8111-111111111111',
  answer: 'A persisted answer.',
}

const jsonResponse = (payload: unknown) =>
  new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      'content-type': 'application/json',
    },
  })

describe('chat API ephemeral bootstrap handling', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('does not report a conversation event for authenticated bootstrap responses without a conversation id', async () => {
    const { chatApi } = await import('@/lib/api')
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(bootstrapPayload))
    vi.stubGlobal('fetch', fetchMock)

    const onConversation = vi.fn()
    const onDone = vi.fn()
    const response = await chatApi.streamChatResponse(
      { stream: false, bootstrapGreeting: true },
      { onConversation, onDone },
    )

    expect(response).not.toHaveProperty('conversationId')
    expect(onConversation).not.toHaveBeenCalled()
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: undefined,
      answer: bootstrapPayload.answer,
    }))
  })

  it('omits conversationId on the first authenticated user turn after an ephemeral greeting', async () => {
    const { chatApi } = await import('@/lib/api')
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(turnPayload))
    vi.stubGlobal('fetch', fetchMock)

    await chatApi.streamChatResponse({ query: 'Hi', stream: true })

    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(requestBody).not.toHaveProperty('conversationId')
  })

  it('omits conversationId on the first public user turn after an ephemeral greeting', async () => {
    const { publicChatApi } = await import('@/lib/api')
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(turnPayload))
    vi.stubGlobal('fetch', fetchMock)

    await publicChatApi.streamMessage('public-token', { message: 'Hi', stream: true })

    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(requestBody).not.toHaveProperty('conversationId')
  })
})
