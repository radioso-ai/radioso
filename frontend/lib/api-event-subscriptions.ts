import { request } from './api-client'

// The URLs an automation client (Zapier, n8n, a custom receiver) subscribed to workspace events, as
// GET /workspace/event-subscriptions reports them. Clients create their own; Settings lists and
// deletes them.

export type EventSubscriptionLabel = 'zapier' | 'n8n' | 'custom'
export type EventSubscriptionStatus = 'active' | 'disabled'
export type EventSubscriptionDisabledReason = 'delivery_failing' | 'creator_revoked'
export type EventSubscriptionCreatorKind = 'service_account' | 'personal_token' | 'teammate'

export interface EventSubscription {
  id: string
  label: EventSubscriptionLabel
  /** Where events go. The full target URL is never returned. */
  targetHost: string
  eventTypes: string[]
  status: EventSubscriptionStatus
  disabledReason: EventSubscriptionDisabledReason | null
  createdAt: string
  createdBy: { kind: EventSubscriptionCreatorKind; label: string | null }
  lastDelivery: { at: string; outcome: 'delivered' | 'failed'; statusCode: number | null } | null
  failingSince: string | null
}

export const EVENT_SUBSCRIPTION_LABELS: Record<EventSubscriptionLabel, string> = {
  zapier: 'Zapier',
  n8n: 'n8n',
  custom: 'Custom',
}

export const EVENT_SUBSCRIPTION_CREATOR_KINDS: Record<EventSubscriptionCreatorKind, string> = {
  service_account: 'Service account',
  personal_token: 'Personal token',
  teammate: 'Teammate',
}

/** What a subscription's status means to an operator: delivering, failing, or stopped and why. */
export const eventSubscriptionState = (subscription: EventSubscription): string => {
  if (subscription.status === 'disabled') {
    return subscription.disabledReason === 'creator_revoked'
      ? 'Stopped: its creator lost access'
      : 'Stopped: failing for a day'
  }
  return subscription.failingSince ? 'Failing, retrying' : 'Active'
}

const workspaceHeaders = (workspaceId: string): HeadersInit => ({ 'X-Workspace-Id': workspaceId })

export const eventSubscriptionsApi = {
  async list(workspaceId: string): Promise<EventSubscription[]> {
    const response = await request<{ subscriptions: EventSubscription[] }>('/workspace/event-subscriptions', {
      method: 'GET',
      headers: workspaceHeaders(workspaceId),
    }, { withSession: true })
    return response.subscriptions
  },

  async delete(workspaceId: string, subscriptionId: string): Promise<void> {
    await request<void>(`/workspace/event-subscriptions/${encodeURIComponent(subscriptionId)}`, {
      method: 'DELETE',
      headers: workspaceHeaders(workspaceId),
    }, { withSession: true })
  },
}
