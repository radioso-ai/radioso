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
  VisitorConversationsResponse,
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
    // outcome bucket, and caller kind. Each narrows results to chat rows only (search/contact rows have
    // none of these facets).
    q?: string
    agentId?: string
    sourceOrigin?: string
    outcome?: 'in_progress' | 'completed' | 'handed_off'
    callerKind?: 'human' | 'agent'
  }, signal?: AbortSignal): Promise<HistoryItemsResponse> {
    const filters = {
      limit: input?.limit,
      offset: input?.offset,
      agentId: input?.agentId,
      sourceOrigin: input?.sourceOrigin,
      outcome: input?.outcome,
      callerKind: input?.callerKind,
    }
    // A text search travels in the request body: request logs record a URL's query string, and
    // operators type visitors' words into this search.
    const response = input?.q
      ? await request<HistoryItemsApiResponse>('/history/query', {
        method: 'POST',
        body: JSON.stringify({ ...filters, q: input.q }),
        ...(signal ? { signal } : {}),
      }, { withSession: true })
      : await request<HistoryItemsApiResponse>(withQuery('/history', filters), {
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
    agentId?: string
    channel?: string
  }, signal?: AbortSignal): Promise<ChatHistoryListResponse> {
    return request<ChatHistoryListResponse>(withQuery('/history/chat', {
      limit: input?.limit,
      offset: input?.offset,
      cursor: input?.cursor,
      sourceScope: input?.sourceScope,
      ownership: input?.ownership,
      agentId: input?.agentId,
      channel: input?.channel,
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

  /** Permanently erases the conversation and everything derived from it. */
  async deleteHistoryConversation(conversationId: string): Promise<void> {
    await request<void>(`/history/chat/${encodeURIComponent(conversationId)}`, {
      method: 'DELETE',
    }, { withSession: true })
  },

  async listVisitorConversations(
    visitorId: string,
    input?: { limit?: number; offset?: number; cursor?: string; exclude?: string },
    signal?: AbortSignal,
  ): Promise<VisitorConversationsResponse> {
    return request<VisitorConversationsResponse>(withQuery(`/history/visitors/${visitorId}/conversations`, {
      limit: input?.limit,
      offset: input?.offset,
      cursor: input?.cursor,
      exclude: input?.exclude,
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
