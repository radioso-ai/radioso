import { afterEach, describe, expect, it, vi } from 'vitest'

import { eventSubscriptionState, eventSubscriptionsApi, type EventSubscription } from '@/lib/api-event-subscriptions'

const subscription = (overrides: Partial<EventSubscription> = {}): EventSubscription => ({
  id: '6f1c2a40-0000-4000-8000-000000000001',
  label: 'n8n',
  targetHost: 'automation.example',
  eventTypes: ['handoff.requested'],
  status: 'active',
  disabledReason: null,
  createdAt: '2026-11-10T09:00:00.000Z',
  createdBy: { kind: 'personal_token', label: 'Office automation' },
  lastDelivery: null,
  failingSince: null,
  ...overrides,
})

const response = (payload: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => 'application/json' },
  json: async () => payload,
})

describe('eventSubscriptionState', () => {
  it('tells delivering, retrying and the two ways a subscription stops apart', () => {
    expect(eventSubscriptionState(subscription())).toBe('active')
    expect(eventSubscriptionState(subscription({ failingSince: '2026-11-11T09:00:00.000Z' }))).toBe('retrying')
    expect(eventSubscriptionState(subscription({ status: 'disabled', disabledReason: 'delivery_failing' }))).toBe('stopped_failing')
    expect(eventSubscriptionState(subscription({ status: 'disabled', disabledReason: 'creator_revoked' }))).toBe('stopped_creator_revoked')
  })
})

describe('eventSubscriptionsApi.delete', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('counts a subscription that is already gone as deleted', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ error: { code: 'not_found', message: 'Event subscription not found' } }, 404)))

    await expect(eventSubscriptionsApi.delete('workspace-1', 'subscription-1')).resolves.toBeUndefined()
  })

  it('reports any other failure, scoped to the workspace it was asked for', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ error: { code: 'forbidden', message: 'Forbidden' } }, 403))
    vi.stubGlobal('fetch', fetchMock)

    await expect(eventSubscriptionsApi.delete('workspace-1', 'subscription-1')).rejects.toMatchObject({ status: 403 })
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('X-Workspace-Id')).toBe('workspace-1')
  })
})
