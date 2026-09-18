import { request } from './api-client'
import { withQuery } from './api-query'
import { normalizeHistoryItemsResponse } from './api-types'
import type {
  ChatConversationDetail,
  ChatHistoryListResponse,
  ContactHistoryDetailResponse,
  ContactHistoryListResponse,
  DocumentSearchHistoryListResponse,
  DocumentSearchResponse,
  HistoryItemsApiResponse,
  HistoryItemsResponse,
} from './api-types'

const normalizeDocumentSearchResponse = (payload: DocumentSearchResponse): DocumentSearchResponse => ({
  ...payload,
  activityTrace: payload.activityTrace ?? payload.debug?.activityTrace,
})

export const chatApi = {
  async listHistory(input?: {
    limit?: number
    offset?: number
    // Server-side All-lens toolbar filters (issue #1126): case-insensitive substring over
    // the conversation's generated title or first user message, agent, exact site origin,
    // and outcome bucket. Each narrows results to chat rows only (search/contact rows have
    // none of these facets).
    q?: string
    agentId?: string
    sourceOrigin?: string
    outcome?: 'in_progress' | 'completed' | 'handed_off'
  }, signal?: AbortSignal): Promise<HistoryItemsResponse> {
    const response = await request<HistoryItemsApiResponse>(withQuery('/history', {
      limit: input?.limit,
      offset: input?.offset,
      q: input?.q,
      agentId: input?.agentId,
      sourceOrigin: input?.sourceOrigin,
      outcome: input?.outcome,
    }), {
      method: 'GET',
      ...(signal ? { signal } : {}),
    }, { withSession: true })

    return normalizeHistoryItemsResponse(response)
  },

  async listChatHistory(input?: {
    limit?: number
    offset?: number
    cursor?: string
    // `end_user` (server default) hides the operator's own test chats; `operator_test`
    // returns only them (the workbench's recent test sessions); `all` returns both.
    sourceScope?: 'end_user' | 'operator_test' | 'all'
    ownership?: 'human_owned'
  }, signal?: AbortSignal): Promise<ChatHistoryListResponse> {
    return request<ChatHistoryListResponse>(withQuery('/history/chat', {
      limit: input?.limit,
      offset: input?.offset,
      cursor: input?.cursor,
      sourceScope: input?.sourceScope,
      ownership: input?.ownership,
    }), {
      method: 'GET',
      ...(signal ? { signal } : {}),
    }, { withSession: true })
  },

  async listSearchHistory(input?: { limit?: number; offset?: number; cursor?: string }, signal?: AbortSignal): Promise<DocumentSearchHistoryListResponse> {
    return request<DocumentSearchHistoryListResponse>(withQuery('/history/search', {
      limit: input?.limit,
      offset: input?.offset,
      cursor: input?.cursor,
    }), {
      method: 'GET',
      ...(signal ? { signal } : {}),
    }, { withSession: true })
  },

  async listContactHistory(input?: { limit?: number; offset?: number }, signal?: AbortSignal): Promise<ContactHistoryListResponse> {
    return request<ContactHistoryListResponse>(withQuery('/history/contact', {
      limit: input?.limit,
      offset: input?.offset,
    }), {
      method: 'GET',
      ...(signal ? { signal } : {}),
    }, { withSession: true })
  },

  async getHistoryConversation(
    conversationId: string,
    input?: { limit?: number; offset?: number; cursor?: string },
    signal?: AbortSignal,
  ): Promise<ChatConversationDetail> {
    return request<ChatConversationDetail>(withQuery(`/history/chat/${conversationId}`, {
      limit: input?.limit,
      offset: input?.offset,
      cursor: input?.cursor,
    }), {
      method: 'GET',
      ...(signal ? { signal } : {}),
    }, { withSession: true })
  },

  async getSearchHistory(searchId: string, signal?: AbortSignal): Promise<DocumentSearchResponse> {
    const payload = await request<DocumentSearchResponse>(`/history/search/${searchId}?includeDebug=true`, {
      method: 'GET',
      ...(signal ? { signal } : {}),
    }, { withSession: true })
    return normalizeDocumentSearchResponse(payload)
  },

  async getContactHistory(
    requestId: string,
    input?: { limit?: number; offset?: number; cursor?: string },
    signal?: AbortSignal,
  ): Promise<ContactHistoryDetailResponse> {
    return request<ContactHistoryDetailResponse>(withQuery(`/history/contact/${requestId}`, {
      limit: input?.limit,
      offset: input?.offset,
      cursor: input?.cursor,
    }), {
      method: 'GET',
      ...(signal ? { signal } : {}),
    }, { withSession: true })
  },
}
