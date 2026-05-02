import {
  attachAnonymousSessionHeader,
  persistAnonymousSessionHeader,
  storePublicSessionToken,
} from './embed-session-storage'
import type {
  AnswerSegment,
  ChatConversationDetail,
  ChatHistoryListResponse,
  ChatResponse,
  ChatStreamChunk,
  ChatStreamCompletion,
  ChatStreamConversation,
  ChatStreamHandlers,
  ChatStreamSuggestions,
  ChatSuggestion,
  ChatUserInputMetadata,
  Citation,
  ErrorResponse,
  PublicChatSessionResponse,
  RetrievalInfo,
  RetrievalTrace,
  WebsiteEmbedPageContext,
} from './public-chat-types'

const API_BASE = `${process.env.NEXT_PUBLIC_API_BASE_PATH ?? '/backend/api/v1'}`
const PUBLIC_CHAT_STREAMING_API_PATH = '/api/public/chat'

const buildError = async (response: Response): Promise<ErrorResponse> => {
  try {
    const payload = await response.json()
    if (
      payload &&
      typeof payload === 'object' &&
      'error' in payload &&
      payload.error &&
      typeof payload.error === 'object'
    ) {
      return payload as ErrorResponse
    }

    if (
      payload &&
      typeof payload === 'object' &&
      'code' in payload &&
      typeof payload.code === 'string' &&
      'message' in payload &&
      typeof payload.message === 'string'
    ) {
      return {
        error: {
          code: payload.code,
          message: payload.message,
          retryAfterSeconds:
            'retryAfterSeconds' in payload && typeof payload.retryAfterSeconds === 'number'
              ? payload.retryAfterSeconds
              : undefined,
        },
      }
    }
  } catch {
    // Fall through to generic HTTP error.
  }

  return {
    error: {
      code: 'HTTP_ERROR',
      message: `Request failed with status ${response.status}`,
    },
  }
}

const parseSseEvent = (rawEvent: string) => {
  const normalized = rawEvent.replaceAll('\r', '')
  const lines = normalized.split('\n')
  let eventName = 'message'
  const dataLines: string[] = []

  for (const line of lines) {
    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim()
      continue
    }

    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim())
    }
  }

  return {
    eventName,
    data: dataLines.join('\n'),
  }
}

const streamChatEvents = async (
  response: Response,
  handlers: ChatStreamHandlers,
): Promise<ChatResponse> => {
  if (!response.body) {
    throw new Error('Streaming response body was unavailable.')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let answer = ''
  let conversationId = ''
  let citations: Citation[] | undefined
  let answerSegments: AnswerSegment[] | undefined
  let suggestions: ChatSuggestion[] | undefined
  let conversationMode: ChatResponse['conversationMode'] | undefined
  let conversationModeMetadata: ChatResponse['conversationModeMetadata'] | undefined
  let retrievalInfo: RetrievalInfo | undefined
  let retrievalTrace: RetrievalTrace | undefined
  let route: ChatResponse['route'] | undefined

  const flushEvent = (rawEvent: string) => {
    if (!rawEvent.trim()) {
      return
    }

    const { eventName, data } = parseSseEvent(rawEvent)
    if (!data) {
      return
    }

    const payload = JSON.parse(data) as
      | (ChatStreamConversation & { type?: 'conversation' })
      | (ChatStreamChunk & { type?: 'chunk' })
      | (ChatStreamSuggestions & { type?: 'suggestions' })
      | (ChatStreamCompletion & { type?: 'done' })

    const normalizedEventName =
      eventName === 'message' && 'type' in payload && typeof payload.type === 'string'
        ? payload.type
        : eventName

    if (normalizedEventName === 'conversation') {
      const conversationPayload = payload as ChatStreamConversation
      conversationId = conversationPayload.conversationId
      handlers.onConversation?.(conversationPayload)
      return
    }

    if (normalizedEventName === 'chunk') {
      const chunkPayload = payload as ChatStreamChunk
      answer = `${answer}${chunkPayload.text}`
      handlers.onChunk?.(chunkPayload)
      return
    }

    if (normalizedEventName === 'done') {
      const completionPayload = payload as ChatStreamCompletion
      conversationId = completionPayload.conversationId ?? conversationId
      answer = completionPayload.answer ?? answer
      citations = completionPayload.citations
      answerSegments = completionPayload.answerSegments
      suggestions = completionPayload.suggestions
      conversationMode = completionPayload.conversationMode
      conversationModeMetadata = completionPayload.conversationModeMetadata
      retrievalInfo = completionPayload.retrievalInfo
      retrievalTrace = completionPayload.retrievalTrace
      route = completionPayload.route
      handlers.onDone?.({
        conversationId,
        route,
        answer,
        citations,
        answerSegments,
        suggestions,
        conversationMode,
        conversationModeMetadata,
        retrievalInfo,
        retrievalTrace,
      })
      return
    }

    if (normalizedEventName === 'suggestions') {
      const suggestionsPayload = payload as ChatStreamSuggestions
      conversationId = suggestionsPayload.conversationId ?? conversationId
      suggestions = suggestionsPayload.suggestions
      conversationModeMetadata = suggestionsPayload.conversationModeMetadata ?? conversationModeMetadata
      handlers.onSuggestions?.({
        conversationId,
        suggestions,
        conversationModeMetadata,
      })
    }
  }

  while (true) {
    const { done, value } = await reader.read()
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done })

    let delimiterIndex = buffer.indexOf('\n\n')
    while (delimiterIndex !== -1) {
      flushEvent(buffer.slice(0, delimiterIndex))
      buffer = buffer.slice(delimiterIndex + 2)
      delimiterIndex = buffer.indexOf('\n\n')
    }

    if (done) {
      break
    }
  }

  if (buffer.trim()) {
    flushEvent(buffer)
  }

  return {
    conversationId,
    route,
    answer,
    citations,
    answerSegments,
    suggestions,
    conversationMode: conversationMode!,
    conversationModeMetadata: conversationModeMetadata!,
    retrievalInfo: retrievalInfo!,
    retrievalTrace: retrievalTrace!,
  }
}

export const publicChatApi = {
  async createSession(
    token: string,
    data: {
      channel: 'anonymous_link' | 'website_embed'
      anonymousSessionId?: string | null
      pageContext?: WebsiteEmbedPageContext | null
    },
  ): Promise<PublicChatSessionResponse> {
    const response = await fetch(`${API_BASE}/public/chat/${token}/sessions`, {
      method: 'POST',
      cache: 'no-store',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-Prefix': '/backend',
      },
      body: JSON.stringify({
        channel: data.channel,
        anonymousSessionId: data.anonymousSessionId ?? undefined,
        pageContext: data.pageContext,
      }),
    })

    if (!response.ok) {
      throw await buildError(response)
    }

    const session = await response.json() as PublicChatSessionResponse
    storePublicSessionToken(session.publicChatToken, session.publicSessionToken, session.expiresAt)
    return session
  },

  async sendMessage(
    token: string,
    data: {
      message: string
      stream: boolean
      conversationId?: string
      inputMetadata?: ChatUserInputMetadata
      userExpectedLocale?: string
      pageContext?: WebsiteEmbedPageContext | null
    },
  ): Promise<ChatResponse> {
    const response = await fetch(`${API_BASE}/public/chat/${token}`, {
      method: 'POST',
      cache: 'no-store',
      credentials: 'include',
      headers: attachAnonymousSessionHeader(token, {
        'Content-Type': 'application/json',
        'X-Forwarded-Prefix': '/backend',
      }),
      body: JSON.stringify(data),
    })

    if (!response.ok) {
      throw await buildError(response)
    }

    persistAnonymousSessionHeader(token, response)
    return response.json() as Promise<ChatResponse>
  },

  async streamMessage(
    token: string,
    data: {
      message: string
      stream: boolean
      conversationId?: string
      inputMetadata?: ChatUserInputMetadata
      userExpectedLocale?: string
      pageContext?: WebsiteEmbedPageContext | null
    },
    handlers: ChatStreamHandlers = {},
  ): Promise<ChatResponse> {
    const response = await fetch(`${PUBLIC_CHAT_STREAMING_API_PATH}/${encodeURIComponent(token)}`, {
      method: 'POST',
      cache: 'no-store',
      credentials: 'include',
      headers: attachAnonymousSessionHeader(token, {
        'Content-Type': 'application/json',
      }),
      body: JSON.stringify(data),
    })

    if (!response.ok) {
      throw await buildError(response)
    }

    persistAnonymousSessionHeader(token, response)

    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.includes('text/event-stream')) {
      const payload = (await response.json()) as ChatResponse
      handlers.onConversation?.({ conversationId: payload.conversationId })
      if (payload.answer) {
        handlers.onChunk?.({ text: payload.answer })
      }
      handlers.onDone?.({
        conversationId: payload.conversationId,
        route: payload.route,
        answer: payload.answer,
        citations: payload.citations,
        answerSegments: payload.answerSegments,
        suggestions: payload.suggestions,
        conversationMode: payload.conversationMode,
        conversationModeMetadata: payload.conversationModeMetadata,
        retrievalInfo: payload.retrievalInfo,
        retrievalTrace: payload.retrievalTrace,
      })
      return payload
    }

    return streamChatEvents(response, handlers)
  },

  async bootstrapConversation(
    token: string,
    data: {
      stream: boolean
      startConversation: true
      userExpectedLocale?: string
      pageContext?: WebsiteEmbedPageContext | null
    },
  ): Promise<ChatResponse | undefined> {
    const response = await fetch(`${API_BASE}/public/chat/${token}`, {
      method: 'POST',
      cache: 'no-store',
      credentials: 'include',
      headers: attachAnonymousSessionHeader(token, {
        'Content-Type': 'application/json',
        'X-Forwarded-Prefix': '/backend',
      }),
      body: JSON.stringify(data),
    })

    if (!response.ok) {
      throw await buildError(response)
    }

    persistAnonymousSessionHeader(token, response)
    if (response.status === 204) {
      return undefined
    }

    return response.json() as Promise<ChatResponse>
  },

  async listConversations(
    token: string,
    input?: { limit?: number; offset?: number; cursor?: string },
  ): Promise<ChatHistoryListResponse> {
    const query = buildPaginationQuery(input)
    const response = await fetch(`${API_BASE}/public/chat/${token}${query}`, {
      method: 'GET',
      cache: 'no-store',
      credentials: 'include',
      headers: attachAnonymousSessionHeader(token, {
        'X-Forwarded-Prefix': '/backend',
      }),
    })

    if (!response.ok) {
      throw await buildError(response)
    }

    persistAnonymousSessionHeader(token, response)
    return response.json() as Promise<ChatHistoryListResponse>
  },

  async getConversationDetail(
    token: string,
    conversationId: string,
    input?: { limit?: number; offset?: number; cursor?: string },
  ): Promise<ChatConversationDetail> {
    const query = buildPaginationQuery(input)
    const response = await fetch(`${API_BASE}/public/chat/${token}/history/${conversationId}${query}`, {
      method: 'GET',
      cache: 'no-store',
      credentials: 'include',
      headers: attachAnonymousSessionHeader(token, {
        'X-Forwarded-Prefix': '/backend',
      }),
    })

    if (!response.ok) {
      throw await buildError(response)
    }

    persistAnonymousSessionHeader(token, response)
    return response.json() as Promise<ChatConversationDetail>
  },
}

const buildPaginationQuery = (input?: { limit?: number; offset?: number; cursor?: string }) => {
  const searchParams = new URLSearchParams()
  if (input?.limit !== undefined) {
    searchParams.set('limit', String(input.limit))
  }
  if (input?.offset !== undefined) {
    searchParams.set('offset', String(input.offset))
  }
  if (input?.cursor !== undefined) {
    searchParams.set('cursor', input.cursor)
  }

  const query = searchParams.toString()
  return query ? `?${query}` : ''
}
