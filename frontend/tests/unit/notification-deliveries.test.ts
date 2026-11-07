import { describe, expect, it } from 'vitest'

import {
  appendNotificationDeliveryPage,
  canResendConfirmation,
  parseNotificationDeliveryPage,
  type NotificationDelivery,
} from '@/lib/notification-deliveries'

const delivery = (overrides: Partial<NotificationDelivery> = {}): NotificationDelivery => ({
  id: '44444444-4444-4444-8444-444444444444',
  agentId: '22222222-2222-4222-8222-222222222222',
  conversationId: '33333333-3333-4333-8333-333333333333',
  kind: 'handoff',
  recipientEmail: 'front-desk@example.com',
  outcome: 'skipped_unconfirmed',
  createdAt: '2026-11-07T10:00:00.000Z',
  updatedAt: '2026-11-07T10:00:05.000Z',
  ...overrides,
})

describe('parseNotificationDeliveryPage', () => {
  it('reads a page and its cursor', () => {
    expect(parseNotificationDeliveryPage({ items: [delivery()], nextCursor: 'next' }))
      .toEqual({ items: [delivery()], nextCursor: 'next' })
    expect(parseNotificationDeliveryPage({ items: [], nextCursor: null })).toEqual({ items: [], nextCursor: null })
  })

  it('accepts a delivery whose agent is gone', () => {
    expect(parseNotificationDeliveryPage({ items: [delivery({ agentId: null })], nextCursor: null }).items[0]?.agentId).toBeNull()
  })

  it('rejects a payload the dashboard cannot show truthfully', () => {
    expect(() => parseNotificationDeliveryPage(null)).toThrow()
    expect(() => parseNotificationDeliveryPage({ items: 'none', nextCursor: null })).toThrow()
    expect(() => parseNotificationDeliveryPage({ items: [], nextCursor: 3 })).toThrow()
    expect(() => parseNotificationDeliveryPage({ items: [{ ...delivery(), outcome: 'delivered' }], nextCursor: null })).toThrow()
    expect(() => parseNotificationDeliveryPage({ items: [{ ...delivery(), kind: 'newsletter' }], nextCursor: null })).toThrow()
    expect(() => parseNotificationDeliveryPage({ items: [{ ...delivery(), recipientEmail: undefined }], nextCursor: null })).toThrow()
  })
})

describe('appendNotificationDeliveryPage', () => {
  it('adds a further page without repeating a row the list already holds', () => {
    const first = delivery({ id: 'a' })
    const second = delivery({ id: 'b' })
    const third = delivery({ id: 'c' })

    expect(appendNotificationDeliveryPage([first, second], [second, third]).map((item) => item.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('canResendConfirmation', () => {
  it('offers a resend only for an address that has not confirmed', () => {
    expect(canResendConfirmation('skipped_unconfirmed')).toBe(true)
    for (const outcome of ['sent', 'skipped_revoked', 'skipped_suppressed', 'skipped_cap', 'not_dispatched', 'failed'] as const) {
      expect(canResendConfirmation(outcome)).toBe(false)
    }
  })
})
