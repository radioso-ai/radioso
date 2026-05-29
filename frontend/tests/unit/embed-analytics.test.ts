import { describe, expect, it, vi } from 'vitest'

import {
  WEBSITE_EMBED_ANALYTICS_MESSAGE,
  buildWebsiteEmbedAnalyticsMessage,
  postWebsiteEmbedAnalyticsEvent,
} from '@/lib/embed-analytics'

describe('website embed analytics bridge', () => {
  it('builds a sanitized host-page analytics message', () => {
    const message = buildWebsiteEmbedAnalyticsMessage({
      event: 'chat.completed',
      timestamp: '2026-05-27T10:00:00.000Z',
      subjectType: 'conversation',
      subjectId: 'conversation-1',
      properties: {
        inputMethod: 'typed',
        citationCount: 2,
        ignored: undefined,
        nested: { unsafe: true },
      },
    })

    expect(message).toEqual({
      type: WEBSITE_EMBED_ANALYTICS_MESSAGE,
      event: 'chat.completed',
      timestamp: '2026-05-27T10:00:00.000Z',
      source: 'embed',
      subjectType: 'conversation',
      subjectId: 'conversation-1',
      properties: {
        inputMethod: 'typed',
        citationCount: 2,
      },
    })
  })

  it('posts analytics only when running inside an embed iframe', () => {
    const postMessage = vi.fn()
    const parent = { postMessage }
    const windowLike = {
      parent,
    }

    const message = postWebsiteEmbedAnalyticsEvent({
      window: windowLike,
      event: 'website_embed.loaded',
      timestamp: '2026-05-27T10:00:00.000Z',
      subjectType: 'embed_session',
      subjectId: 'session-1',
    })

    expect(message?.event).toBe('website_embed.loaded')
    expect(postMessage).toHaveBeenCalledWith(message, '*')
  })

  it('allows embed hosts to receive citation click analytics', () => {
    const message = buildWebsiteEmbedAnalyticsMessage({
      event: 'chat.citation_clicked',
      timestamp: '2026-05-27T10:00:00.000Z',
      subjectType: 'conversation',
      subjectId: 'conversation-1',
      properties: {
        linkType: 'citation_source_url',
        citationIndex: 0,
        destinationOrigin: 'https://docs.example.com',
        destinationPath: '/guide',
      },
    })

    expect(message.event).toBe('chat.citation_clicked')
    expect(message.properties).toEqual({
      linkType: 'citation_source_url',
      citationIndex: 0,
      destinationOrigin: 'https://docs.example.com',
      destinationPath: '/guide',
    })
  })

  it('allows embed hosts to receive assistant link click analytics', () => {
    const message = buildWebsiteEmbedAnalyticsMessage({
      event: 'chat.link_clicked',
      timestamp: '2026-05-27T10:00:00.000Z',
      subjectType: 'conversation',
      subjectId: 'conversation-1',
      properties: {
        linkType: 'assistant_url',
        destinationOrigin: 'https://docs.example.com',
        destinationPath: '/guide',
      },
    })

    expect(message.event).toBe('chat.link_clicked')
    expect(message.properties).toEqual({
      linkType: 'assistant_url',
      destinationOrigin: 'https://docs.example.com',
      destinationPath: '/guide',
    })
  })
})
