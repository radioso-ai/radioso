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
import { streamChatEvents } from './api-chat-stream'
import { buildQueryString } from './api-query'
import type {
  ChatConversationDetail,
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
    data: { message: string; stream: boolean; conversationId?: string; inputMetadata?: ChatUserInputMetadata; userExpectedLocale?: string; pageContext?: WebsiteEmbedPageContext | null },
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
    data: { message: string; stream: boolean; conversationId?: string; inputMetadata?: ChatUserInputMetadata; userExpectedLocale?: string; pageContext?: WebsiteEmbedPageContext | null },
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

}
