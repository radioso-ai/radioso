import { describe, expect, it, vi } from 'vitest'

import {
  BeaconFrontendProductAnalyticsSink,
  createFrontendProductAnalyticsEmitter,
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

    expect(event).toEqual({
      eventName: 'chat.citation_clicked',
      timestamp: '2026-04-22T10:00:00.000Z',
      workspaceId: undefined,
      accountId: undefined,
      actorType: undefined,
      subjectType: 'conversation',
      subjectId: 'conversation-1',
      properties: undefined,
      source: 'frontend',
    })
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
})
