import { request } from './api-client'
import { withQuery } from './api-query'

/**
 * Where a held reply stands. `released` went out as written and `edited` as the operator changed
 * it; `discarded` and `superseded` never went out. `queued_auto` is waiting for an automatic send.
 */
type HeldReplyState = 'pending' | 'queued_auto' | 'released' | 'edited' | 'discarded' | 'superseded'

/**
 * The review turn's reasoning, as identifiers and codes: how it answered, whether its claims are
 * supported, how completely it covered the question, why it asked for a person, and the skills it
 * was not allowed to run. Never prompt, completion or customer text.
 */
export type HeldReplyTrace = {
  turnId: string
  outcome: string | null
  groundingVerdict: 'grounded' | 'degraded' | 'no_support' | null
  coverage: string
  handoffReason: string | null
  suppressedEffects: { skillName: string }[]
}

/**
 * A reply the agent wrote that waits for an operator before it reaches the customer, with what the
 * turn found. Fact values are producer codes, rendered through the Inbox's own copy.
 */
export type HeldReply = {
  id: string
  conversationId: string
  agentId: string | null
  state: HeldReplyState
  holdReason: string
  facts: {
    grounding: string
    coverage: string
    handoff: { requested: boolean; reason: string | null }
    outcome: string
  }
  /** The reply relies on an action the turn was not allowed to run. */
  dependsOnSuppressedAction: boolean
  suppressedEffects: { skillName: string }[]
  /** The agent's text, kept as written even after an edited release. */
  draftText: string
  editedText: string | null
  createdAt: string
  decidedAt: string | null
  releaserUserId: string | null
  editorUserId: string | null
  /** Whether the conversation still waits on an operator because of this reply. */
  attentionOpen: boolean
  /** Null when the review turn's record is not readable. */
  trace: HeldReplyTrace | null
}

type HeldReplyPage = { items: HeldReply[]; nextCursor: string | null }

type HeldReplyQuery = {
  attention?: 'open' | 'all'
  agentId?: string
  cursor?: string | null
  limit?: number
}

type HeldReplyReleaseResult = { heldReply: HeldReply; messageId: string; delivery: 'queued' }

/**
 * How a reply failed to reach the customer: bounced, refused or failed, of an outcome nobody knows,
 * or halted before it was sent because the authority to send it was gone.
 */
type DeliveryFailureKind = 'bounced' | 'failed' | 'uncertain' | 'halted'

/** A reply that may not have reached the customer, on any channel that delivers replies. */
export type DeliveryFailure = {
  id: string
  conversationId: string
  /** Null for a failure that names no message. */
  messageId: string | null
  provider: string
  kind: DeliveryFailureKind
  /** The provider's code, sanitized; never its bounce message. */
  detailCode: string | null
  openedAt: string
  clearedAt: string | null
  clearReason: 'acknowledged' | 'later_delivery' | 'provider_evidence' | 'operator_resolved' | null
}

type DeliveryFailurePage = { items: DeliveryFailure[]; nextCursor: string | null }

type DeliveryFailureQuery = {
  state?: 'open' | 'all'
  agentId?: string
  cursor?: string | null
  limit?: number
}

/** `marked_sent` settles an uncertain send as sent; `resend` sends an uncertain or halted reply once more. */
type DeliveryFailureResolution = 'marked_sent' | 'resend'

const failurePath = (failureId: string, action: 'acknowledge' | 'resolve') =>
  `/delivery-failures/${encodeURIComponent(failureId)}/${action}`

const conversationPath = (conversationId: string) => `/conversations/${encodeURIComponent(conversationId)}`

const heldReplyPath = (conversationId: string, heldReplyId: string, action: 'release' | 'discard') =>
  `${conversationPath(conversationId)}/held-replies/${encodeURIComponent(heldReplyId)}/${action}`

/**
 * The operator review of replies to customers: held replies before they are sent, and delivery
 * failures after.
 */
export const replyReviewApi = {
  listHeldReplies(query: HeldReplyQuery = {}, signal?: AbortSignal): Promise<HeldReplyPage> {
    return request<HeldReplyPage>(
      withQuery('/held-replies', {
        attention: query.attention,
        agentId: query.agentId,
        cursor: query.cursor,
        limit: query.limit,
      }),
      { method: 'GET', ...(signal ? { signal } : {}) },
    )
  },

  /** The conversation's current held reply, or null when it has none. */
  getCurrentHeldReply(conversationId: string, signal?: AbortSignal): Promise<{ heldReply: HeldReply | null }> {
    return request<{ heldReply: HeldReply | null }>(`${conversationPath(conversationId)}/held-reply`, {
      method: 'GET',
      ...(signal ? { signal } : {}),
    })
  },

  /** Sends the draft as written, or the operator's edit of it when `editedText` is given. */
  releaseHeldReply(conversationId: string, heldReplyId: string, editedText?: string): Promise<HeldReplyReleaseResult> {
    return request<HeldReplyReleaseResult>(heldReplyPath(conversationId, heldReplyId, 'release'), {
      method: 'POST',
      body: JSON.stringify(editedText === undefined ? {} : { editedText }),
    })
  },

  discardHeldReply(conversationId: string, heldReplyId: string): Promise<HeldReply> {
    return request<HeldReply>(heldReplyPath(conversationId, heldReplyId, 'discard'), { method: 'POST' })
  },

  listDeliveryFailures(query: DeliveryFailureQuery = {}, signal?: AbortSignal): Promise<DeliveryFailurePage> {
    return request<DeliveryFailurePage>(
      withQuery('/delivery-failures', {
        state: query.state,
        agentId: query.agentId,
        cursor: query.cursor,
        limit: query.limit,
      }),
      { method: 'GET', ...(signal ? { signal } : {}) },
    )
  },

  acknowledgeDeliveryFailure(failureId: string): Promise<DeliveryFailure> {
    return request<DeliveryFailure>(failurePath(failureId, 'acknowledge'), { method: 'POST' })
  },

  resolveDeliveryFailure(failureId: string, decision: DeliveryFailureResolution): Promise<DeliveryFailure> {
    return request<DeliveryFailure>(failurePath(failureId, 'resolve'), {
      method: 'POST',
      body: JSON.stringify({ decision }),
    })
  },
}
