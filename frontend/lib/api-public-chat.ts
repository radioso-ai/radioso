import {
  API_BASE,
  PUBLIC_CHAT_STREAMING_API_PATH,
  attachAnonymousSessionHeader,
  buildError,
  persistAnonymousSessionHeader,
  storeEffectivePublicChatToken,
  storePublicSessionResumeToken,
  storePublicSessionToken,
} from './api-client'
import { parseSseEvent, streamChatEvents } from './api-chat-stream'
import { buildQueryString } from './api-query'
import type {
  ChatConversationDetail,
  PublicChatConversationTail,
  PublicChatConversationEvent,
  ChatHistoryListResponse,
  ChatResponse,
  ChatStreamHandlers,
  ChatUserInputMetadata,
  PublicChatSessionResponse,
  WebsiteEmbedPageContext,
} from './api-types'

const isInvalidResumeSessionError = (error: unknown) => (
  Boolean(
    error &&
    typeof error === 'object' &&
    'error' in error &&
    error.error &&
    typeof error.error === 'object' &&
    'code' in error.error &&
    error.error.code === 'bad_request' &&
    'message' in error.error &&
    error.error.message === 'Invalid public chat session request',
  )
)

export const publicChatApi = {
  async createSession(
    token: string,
    data: {
      channel: 'anonymous_link' | 'website_embed'
      chatSessionId?: string | null
      /** @deprecated Use chatSessionId. */
      anonymousSessionId?: string | null
      resumeToken?: string | null
      pageContext?: WebsiteEmbedPageContext | null
    },
  ): Promise<PublicChatSessionResponse> {
    const exchange = async (resumeToken?: string | null) => {
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
          resumeToken: resumeToken ?? undefined,
          chatSessionId: data.chatSessionId ?? data.anonymousSessionId ?? undefined,
          anonymousSessionId: data.anonymousSessionId ?? undefined,
          pageContext: data.pageContext,
        }),
      })

      if (!response.ok) {
        throw await buildError(response)
      }

      return response.json() as Promise<PublicChatSessionResponse>
    }

    let session: PublicChatSessionResponse
    try {
      session = await exchange(data.resumeToken)
    } catch (error) {
      if (!data.resumeToken || !isInvalidResumeSessionError(error)) {
        throw error
      }

      storePublicSessionResumeToken(token, null)
      session = await exchange(null)
    }

    storePublicSessionToken(session.publicChatToken, session.publicSessionToken, session.expiresAt)
    storePublicSessionResumeToken(session.publicChatToken, session.resumeToken, session.resumeExpiresAt)
    storeEffectivePublicChatToken(token, session.publicChatToken)
    return session
  },

  async sendMessage(
    token: string,
    data: { message: string; stream: boolean; conversationId?: string; bootstrapGreetingId?: string; inputMetadata?: ChatUserInputMetadata; userExpectedLocale?: string; pageContext?: WebsiteEmbedPageContext | null; signedIdentity?: string | null },
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
    data: { message: string; stream: boolean; conversationId?: string; bootstrapGreetingId?: string; inputMetadata?: ChatUserInputMetadata; userExpectedLocale?: string; pageContext?: WebsiteEmbedPageContext | null; signedIdentity?: string | null },
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
      if (payload.conversationId) {
        handlers.onConversation?.({ conversationId: payload.conversationId })
      }
      if (payload.answer) {
        handlers.onChunk?.({ text: payload.answer })
      }
      handlers.onDone?.({
        conversationId: payload.conversationId,
        assistantMessageId: payload.assistantMessageId,
        agentId: payload.agentId,
        agentName: payload.agentName,
        answer: payload.answer,
        citations: payload.citations,
        answerSegments: payload.answerSegments,
        suggestions: payload.suggestions,
        ownership: payload.ownership,
        debug: payload.debug,
      })
      return payload
    }

    return streamChatEvents(response, handlers)
  },

  async bootstrapConversation(
    token: string,
    data: { stream: boolean; startConversation: true; userExpectedLocale?: string; pageContext?: WebsiteEmbedPageContext | null },
  ): Promise<ChatResponse | undefined> {
    const response = await fetch(`${API_BASE}/public/chat/${token}`, {
      method: 'POST',
      cache: 'no-store',
      headers: attachAnonymousSessionHeader(token, {
        'Content-Type': 'application/json',
        'X-Forwarded-Prefix': '/backend',
      }),
      body: JSON.stringify(data),
      credentials: 'include',
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
    const query = buildQueryString({
      limit: input?.limit,
      offset: input?.offset,
      cursor: input?.cursor,
    })
    const response = await fetch(`${API_BASE}/public/chat/${token}${query ? `?${query}` : ''}`, {
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
    const query = buildQueryString({
      limit: input?.limit,
      offset: input?.offset,
      cursor: input?.cursor,
    })
    const response = await fetch(`${API_BASE}/public/chat/${token}/history/${conversationId}${query ? `?${query}` : ''}`, {
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

  async tailConversation(
    token: string,
    conversationId: string,
    input?: { limit?: number; cursor?: string | null },
  ): Promise<PublicChatConversationTail> {
    const query = buildQueryString({
      limit: input?.limit,
      cursor: input?.cursor ?? undefined,
    })
    const response = await fetch(`${API_BASE}/public/chat/${token}/tail/${conversationId}${query ? `?${query}` : ''}`, {
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
    return response.json() as Promise<PublicChatConversationTail>
  },

  async streamConversationEvents(
    token: string,
    conversationId: string,
    handlers: { onEvent?: (event: PublicChatConversationEvent) => void } = {},
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    const response = await fetch(`${API_BASE}/public/chat/${token}/events/${conversationId}`, {
      method: 'GET',
      cache: 'no-store',
      credentials: 'include',
      signal: options.signal,
      headers: attachAnonymousSessionHeader(token, {
        Accept: 'text/event-stream',
        'X-Forwarded-Prefix': '/backend',
      }),
    })

    if (!response.ok) {
      throw await buildError(response)
    }

    persistAnonymousSessionHeader(token, response)

    if (!response.body) {
      throw new Error('Conversation event stream body was unavailable.')
    }

    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.includes('text/event-stream')) {
      throw new Error('Conversation event stream response was not an event stream.')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    const flushEvent = (rawEvent: string) => {
      if (!rawEvent.trim()) {
        return
      }
      const { eventName, data } = parseSseEvent(rawEvent)
      if (!data) {
        return
      }
      const payload = JSON.parse(data) as Omit<PublicChatConversationEvent, 'type'>
      if (eventName === 'ready' || eventName === 'message.created') {
        handlers.onEvent?.({ ...payload, type: eventName } as PublicChatConversationEvent)
      }
    }

    try {
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
    } finally {
      reader.releaseLock()
    }
  },

}
