import { request } from './api-client'
import { withQuery } from './api-query'

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

export type DeliveryFailurePage = { items: DeliveryFailure[]; nextCursor: string | null }

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

/** The operator review of replies sent to customers: their delivery failures. */
export const replyReviewApi = {
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
