import { ApiError, request } from './api-client'
import type { components } from '../../typescript-sdk/src/generated/types'

// The URLs a receiver subscribed to workspace events over the API, as
// GET /workspace/event-subscriptions reports them. Settings lists and deletes them.

export type EventSubscription = components['schemas']['EventSubscription']
type EventSubscriptionLabel = EventSubscription['label']
type EventSubscriptionCreatorKind = EventSubscription['createdBy']['kind']

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

/** Where a subscription stands: delivering, failing and retrying, or stopped and why. */
type EventSubscriptionState = 'active' | 'retrying' | 'stopped_failing' | 'stopped_creator_revoked'

export const eventSubscriptionState = (subscription: EventSubscription): EventSubscriptionState => {
  switch (subscription.status) {
    case 'active':
      return subscription.failingSince ? 'retrying' : 'active'
    case 'disabled':
      return subscription.disabledReason === 'creator_revoked' ? 'stopped_creator_revoked' : 'stopped_failing'
    default: {
      const unhandled: never = subscription.status
      throw new Error(`Unknown event subscription status: ${String(unhandled)}`)
    }
  }
}

export const EVENT_SUBSCRIPTION_STATE_LABELS: Record<EventSubscriptionState, string> = {
  active: 'Active',
  retrying: 'Failing, retrying',
  stopped_failing: 'Stopped: failing for a day',
  stopped_creator_revoked: 'Stopped: its creator lost access',
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

  /** Deletes it. One already gone, removed by its target's 410 or another teammate, counts as deleted. */
  async delete(workspaceId: string, subscriptionId: string): Promise<void> {
    try {
      await request<void>(`/workspace/event-subscriptions/${encodeURIComponent(subscriptionId)}`, {
        method: 'DELETE',
        headers: workspaceHeaders(workspaceId),
      }, { withSession: true })
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return
      throw error
    }
  },
}
