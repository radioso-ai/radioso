import { request, type ErrorResponse } from './api-client'
import { getApiErrorCode, getApiErrorMessage } from './api-error'
import { withQuery } from './api-query'
import type {
  ChatConversationTail,
  ConversationOperatorsResponse,
  ConversationOwnershipResponse,
  HandBackConversationRequest,
  HumanReplyMessageResponse,
  HumanReplyRequest,
  PendingApprovalDecisionListResponse,
  RecentlyClosedInboxItemsResponse,
  ResolveDecisionRequest,
  ResolveDecisionResponse,
  TakeOverConversationRequest,
  TransferConversationOwnershipRequest,
} from './api-types'

type HitlApiStatus = 404 | 409 | 422

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

/**
 * Why the server refused to send a reply, when the refusal is about the
 * conversation's channel rather than an ownership race: a 409 whose code is not
 * the ownership `conflict` (an email mailbox whose sending is not available, for
 * one). Null for every other failure.
 */
export const replyRefusalReason = (error: unknown): string | null => {
  if (!isHitlApiStatusError(error, 409)) {
    return null
  }
  const code = getApiErrorCode(error)
  if (!code || code === 'conflict') {
    return null
  }
  return getApiErrorMessage(error, '') || null
}

type TransferFailureCause = 'target_unavailable' | 'conversation_missing'

/**
 * Why a transfer 404'd, read from the error code: the target teammate is no
 * longer eligible (`transfer_target_unavailable`), or the conversation itself
 * is gone (`not_found`). Null for any other failure.
 */
export const transferFailureCause = (error: unknown): TransferFailureCause | null => {
  if (!isHitlApiStatusError(error, 404)) {
    return null
  }
  switch (getApiErrorCode(error)) {
    case 'transfer_target_unavailable':
      return 'target_unavailable'
    case 'not_found':
      return 'conversation_missing'
    default:
      return null
  }
}

export const hitlApi = {
  async listPendingDecisions(signal?: AbortSignal): Promise<PendingApprovalDecisionListResponse> {
    return request<PendingApprovalDecisionListResponse>('/decisions', { method: 'GET', ...(signal ? { signal } : {}) }, { withSession: true })
  },

  async resolveDecision(
    agentId: string,
    handle: string,
    body: ResolveDecisionRequest,
  ): Promise<ResolveDecisionResponse> {
    return request<ResolveDecisionResponse>(
      `/agents/${encodeURIComponent(agentId)}/decisions/${encodeURIComponent(handle)}/resolve`,
      { method: 'POST', body: JSON.stringify(body) },
      { withSession: true },
    )
  },

  async takeOverConversation(
    conversationId: string,
    body: TakeOverConversationRequest,
  ): Promise<ConversationOwnershipResponse> {
    return request<ConversationOwnershipResponse>(
      `/conversations/${encodeURIComponent(conversationId)}/takeover`,
      { method: 'POST', body: JSON.stringify(body) },
      { withSession: true },
    )
  },

  async replyAsHuman(conversationId: string, body: HumanReplyRequest): Promise<HumanReplyMessageResponse> {
    return request<HumanReplyMessageResponse>(
      `/conversations/${encodeURIComponent(conversationId)}/reply`,
      { method: 'POST', body: JSON.stringify(body) },
      { withSession: true },
    )
  },

  /** The teammates who can own a conversation in the current workspace: the valid transfer targets. */
  async listConversationOperators(signal?: AbortSignal): Promise<ConversationOperatorsResponse> {
    return request<ConversationOperatorsResponse>(
      '/conversations/operators',
      { method: 'GET', ...(signal ? { signal } : {}) },
      { withSession: true },
    )
  },

  async listRecentlyClosed(
    params: { limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<RecentlyClosedInboxItemsResponse> {
    return request<RecentlyClosedInboxItemsResponse>(
      withQuery('/conversations/recently-closed', params),
      { method: 'GET', ...(signal ? { signal } : {}) },
      { withSession: true },
    )
  },

  async transferConversation(
    conversationId: string,
    body: TransferConversationOwnershipRequest,
  ): Promise<ConversationOwnershipResponse> {
    return request<ConversationOwnershipResponse>(
      `/conversations/${encodeURIComponent(conversationId)}/transfer`,
      { method: 'POST', body: JSON.stringify(body) },
      { withSession: true },
    )
  },

  async handBackConversation(
    conversationId: string,
    body: HandBackConversationRequest,
  ): Promise<ConversationOwnershipResponse> {
    return request<ConversationOwnershipResponse>(
      `/conversations/${encodeURIComponent(conversationId)}/handback`,
      { method: 'POST', body: JSON.stringify(body) },
      { withSession: true },
    )
  },

  async tailConversation(
    conversationId: string,
    params: { cursor?: string; limit?: number; activityCursor?: string } = {},
    signal?: AbortSignal,
  ): Promise<ChatConversationTail> {
    return request<ChatConversationTail>(
      withQuery(`/history/chat/${encodeURIComponent(conversationId)}/tail`, params),
      { method: 'GET', ...(signal ? { signal } : {}) },
      { withSession: true },
    )
  },
}
