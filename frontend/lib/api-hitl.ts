import { request, type ErrorResponse } from './api-client'
import { withQuery } from './api-query'
import type {
  ChatConversationTail,
  ConversationOwnershipResponse,
  HandBackConversationRequest,
  HumanReplyMessageResponse,
  HumanReplyRequest,
  PendingApprovalDecisionListResponse,
  ResolveDecisionRequest,
  ResolveDecisionResponse,
  TakeOverConversationRequest,
  TransferConversationOwnershipRequest,
} from './api-types'

export type HitlApiStatus = 409 | 422

export const getHitlApiErrorStatus = (error: unknown): number | undefined => {
  if (!error || typeof error !== 'object' || !('status' in error)) {
    return undefined
  }

  const status = (error as { status?: unknown }).status
  return typeof status === 'number' ? status : undefined
}

export const isHitlApiStatusError = (
  error: unknown,
  status: HitlApiStatus,
): error is ErrorResponse & { status: HitlApiStatus } => getHitlApiErrorStatus(error) === status

export const hitlApi = {
  async listPendingDecisions(signal?: AbortSignal): Promise<PendingApprovalDecisionListResponse> {
    return request<PendingApprovalDecisionListResponse>('/decisions', { method: 'GET', ...(signal ? { signal } : {}) }, { withApiToken: true })
  },

  async resolveDecision(
    agentId: string,
    handle: string,
    body: ResolveDecisionRequest,
  ): Promise<ResolveDecisionResponse> {
    return request<ResolveDecisionResponse>(
      `/agents/${encodeURIComponent(agentId)}/decisions/${encodeURIComponent(handle)}/resolve`,
      { method: 'POST', body: JSON.stringify(body) },
      { withApiToken: true },
    )
  },

  async takeOverConversation(
    conversationId: string,
    body: TakeOverConversationRequest,
  ): Promise<ConversationOwnershipResponse> {
    return request<ConversationOwnershipResponse>(
      `/conversations/${encodeURIComponent(conversationId)}/takeover`,
      { method: 'POST', body: JSON.stringify(body) },
      { withApiToken: true },
    )
  },

  async replyAsHuman(conversationId: string, body: HumanReplyRequest): Promise<HumanReplyMessageResponse> {
    return request<HumanReplyMessageResponse>(
      `/conversations/${encodeURIComponent(conversationId)}/reply`,
      { method: 'POST', body: JSON.stringify(body) },
      { withApiToken: true },
    )
  },

  async transferConversation(
    conversationId: string,
    body: TransferConversationOwnershipRequest,
  ): Promise<ConversationOwnershipResponse> {
    return request<ConversationOwnershipResponse>(
      `/conversations/${encodeURIComponent(conversationId)}/transfer`,
      { method: 'POST', body: JSON.stringify(body) },
      { withApiToken: true },
    )
  },

  async handBackConversation(
    conversationId: string,
    body: HandBackConversationRequest,
  ): Promise<ConversationOwnershipResponse> {
    return request<ConversationOwnershipResponse>(
      `/conversations/${encodeURIComponent(conversationId)}/handback`,
      { method: 'POST', body: JSON.stringify(body) },
      { withApiToken: true },
    )
  },

  async tailConversation(
    conversationId: string,
    params: { cursor?: string; limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<ChatConversationTail> {
    return request<ChatConversationTail>(
      withQuery(`/history/chat/${encodeURIComponent(conversationId)}/tail`, params),
      { method: 'GET', ...(signal ? { signal } : {}) },
      { withApiToken: true },
    )
  },
}
