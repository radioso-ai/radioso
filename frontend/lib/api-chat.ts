import {
  STREAMING_API_PATH,
  buildError,
  canRetryWithFreshWorkspaceToken,
  refreshWorkspaceApiToken,
  request,
  requireWorkspaceApiToken,
} from './api-client'
import { streamChatEvents } from './api-chat-stream'
import { withQuery } from './api-query'
import { normalizeHistoryItemsResponse, toAssistantChatPayload } from './api-types'
import type {
  ChatConversationDetail,
  ChatHistoryListResponse,
  ChatRequest,
  ChatResponse,
  ChatStreamHandlers,
  ContactHistoryDetailResponse,
  ContactHistoryListResponse,
  DocumentSearchHistoryListResponse,
  DocumentSearchResponse,
  HistoryItemsApiResponse,
  HistoryItemsResponse,
} from './api-types'

const normalizeChatResponse = (payload: ChatResponse): ChatResponse => ({
  ...payload,
  route: payload.route ?? payload.debug?.route,
  activitySummary: payload.activitySummary ?? payload.debug?.activitySummary,
  activityTrace: payload.activityTrace ?? payload.debug?.activityTrace,
})

const normalizeDocumentSearchResponse = (payload: DocumentSearchResponse): DocumentSearchResponse => ({
  ...payload,
  activityTrace: payload.activityTrace ?? payload.debug?.activityTrace,
})

export const chatApi = {
  async createChatResponse(data: ChatRequest): Promise<ChatResponse> {
    const payload = await request<ChatResponse>("/assistant/chat", {
      method: "POST",
      body: JSON.stringify(toAssistantChatPayload({ ...data, includeDebug: data.includeDebug ?? true })),
    }, { withApiToken: true })
    return normalizeChatResponse(payload)
  },

  async streamChatResponse(
    data: ChatRequest,
    handlers: ChatStreamHandlers = {},
  ): Promise<ChatResponse> {
    const headers = new Headers({
      "Content-Type": "application/json",
      Authorization: `Bearer ${await requireWorkspaceApiToken()}`,
    })
    const executeFetch = () => fetch(STREAMING_API_PATH, {
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      headers,
      body: JSON.stringify(toAssistantChatPayload({ ...data, includeDebug: data.includeDebug ?? true })),
    })
    let response = await executeFetch()
    if (canRetryWithFreshWorkspaceToken(response) && await refreshWorkspaceApiToken(headers)) {
      response = await executeFetch()
    }

    if (!response.ok) {
      throw await buildError(response)
    }

    const contentType = response.headers.get("content-type") ?? ""

    if (!contentType.includes("text/event-stream")) {
      const payload = normalizeChatResponse((await response.json()) as ChatResponse)
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
    data: Pick<ChatRequest, 'agentId' | 'stream' | 'bootstrapGreeting' | 'userExpectedLocale'>,
  ): Promise<ChatResponse | undefined> {
    const payload = await request<ChatResponse>('/assistant/chat', {
      method: 'POST',
      body: JSON.stringify(toAssistantChatPayload({ ...data, includeDebug: true })),
    }, { withApiToken: true })
    return payload ? normalizeChatResponse(payload) : payload
  },

  async listHistory(input?: { limit?: number; offset?: number }): Promise<HistoryItemsResponse> {
    const response = await request<HistoryItemsApiResponse>(withQuery('/history', {
      limit: input?.limit,
      offset: input?.offset,
    }), {
      method: 'GET',
    }, { withApiToken: true })

    return normalizeHistoryItemsResponse(response)
  },

  async listChatHistory(input?: {
    limit?: number
    offset?: number
    cursor?: string
    // `end_user` (server default) hides the operator's own test chats; `operator_test`
    // returns only them (the workbench's recent test sessions); `all` returns both.
    sourceScope?: 'end_user' | 'operator_test' | 'all'
  }): Promise<ChatHistoryListResponse> {
    return request<ChatHistoryListResponse>(withQuery('/history/chat', {
      limit: input?.limit,
      offset: input?.offset,
      cursor: input?.cursor,
      sourceScope: input?.sourceScope,
    }), {
      method: 'GET',
    }, { withApiToken: true })
  },

  // Copies a real conversation's thread into a new test-session conversation
  // (source_channel = authenticated_chat) so an operator can continue it in the
  // workbench without touching the original. Returns the new conversation id.
  async forkConversation(sourceConversationId: string): Promise<{ conversationId: string }> {
    return request<{ conversationId: string }>(
      `/conversations/${encodeURIComponent(sourceConversationId)}/fork`,
      { method: 'POST' },
      { withApiToken: true },
    )
  },

  async listSearchHistory(input?: { limit?: number; offset?: number; cursor?: string }): Promise<DocumentSearchHistoryListResponse> {
    return request<DocumentSearchHistoryListResponse>(withQuery('/history/search', {
      limit: input?.limit,
      offset: input?.offset,
      cursor: input?.cursor,
    }), {
      method: 'GET',
    }, { withApiToken: true })
  },

  async listContactHistory(input?: { limit?: number; offset?: number }): Promise<ContactHistoryListResponse> {
    return request<ContactHistoryListResponse>(withQuery('/history/contact', {
      limit: input?.limit,
      offset: input?.offset,
    }), {
      method: 'GET',
    }, { withApiToken: true })
  },

  async getHistoryConversation(
    conversationId: string,
    input?: { limit?: number; offset?: number; cursor?: string },
  ): Promise<ChatConversationDetail> {
    return request<ChatConversationDetail>(withQuery(`/history/chat/${conversationId}`, {
      limit: input?.limit,
      offset: input?.offset,
      cursor: input?.cursor,
    }), {
      method: 'GET',
    }, { withApiToken: true })
  },

  async getSearchHistory(searchId: string): Promise<DocumentSearchResponse> {
    const payload = await request<DocumentSearchResponse>(`/history/search/${searchId}?includeDebug=true`, {
      method: 'GET',
    }, { withApiToken: true })
    return normalizeDocumentSearchResponse(payload)
  },

  async getContactHistory(
    requestId: string,
    input?: { limit?: number; offset?: number; cursor?: string },
  ): Promise<ContactHistoryDetailResponse> {
    return request<ContactHistoryDetailResponse>(withQuery(`/history/contact/${requestId}`, {
      limit: input?.limit,
      offset: input?.offset,
      cursor: input?.cursor,
    }), {
      method: 'GET',
    }, { withApiToken: true })
  },
}
