import { describe, expect, it, vi } from 'vitest'

import {
  BeaconFrontendProductAnalyticsSink,
  createFrontendProductAnalyticsEmitter,
  sanitizePageViewPathname,
} from '@/lib/product-analytics'

describe('frontend product analytics', () => {
  it('emits a typed frontend analytics event to configured sinks', async () => {
    const sink = {
      emit: vi.fn().mockResolvedValue(undefined),
    }
    const emitter = createFrontendProductAnalyticsEmitter({
      now: () => '2026-04-22T10:00:00.000Z',
      sinks: [sink],
    })

    const event = await emitter.track({
      eventName: 'chat.citation_clicked',
      subjectType: 'conversation',
      subjectId: 'conversation-1',
    })

    expect(event).not.toBeNull()
    if (!event) {
      throw new Error('Expected analytics event')
    }
    expect(event.eventName).toBe('chat.citation_clicked')
    expect(event.timestamp).toBe('2026-04-22T10:00:00.000Z')
    expect(event.subjectType).toBe('conversation')
    expect(event.subjectId).toBe('conversation-1')
    expect(event.source).toBe('frontend')
    expect(sink.emit).toHaveBeenCalledWith(event)
  })

  it('uses the beacon-style sink transport without exposing components to vendor code', async () => {
    const send = vi.fn().mockResolvedValue(true)
    const sink = new BeaconFrontendProductAnalyticsSink({
      endpoint: '/api/v1/observability/frontend-event',
      send,
    })

    await sink.emit({
      eventName: 'website_embed.loaded',
      timestamp: '2026-04-22T10:00:00.000Z',
      source: 'embed',
      subjectType: 'embed_session',
      subjectId: 'embed-1',
    })

    expect(send).toHaveBeenCalledWith(
      '/api/v1/observability/frontend-event',
      expect.stringContaining('"eventName":"website_embed.loaded"'),
    )
  })

  it('normalizes page-view paths without preserving secret route segments', () => {
    expect(sanitizePageViewPathname('/invite/super-secret-token')).toBe('/invite/[token]')
    expect(sanitizePageViewPathname('/chat/public-launch-token')).toBe('/chat/[token]')
    expect(sanitizePageViewPathname('/embed/embed-token')).toBe('/embed/[token]')
    expect(sanitizePageViewPathname('/account/account-id/settings')).toBe('/account/[accountId]/settings')
    expect(sanitizePageViewPathname('/w/customer-key/chat')).toBe('/w/[workspaceKey]/chat')
    expect(sanitizePageViewPathname('/reset-password')).toBe('/reset-password')
  })
})
