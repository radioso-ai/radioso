import { describe, expect, it } from 'vitest'

import { buildVisitorPanelViewModel } from '@/lib/visitor-panel'
import type { ConversationRequestContext, ConversationVisitorProfile } from '@/lib/api-types'

const visitor = (overrides: Partial<ConversationVisitorProfile> = {}): ConversationVisitorProfile => ({
  id: 'visitor-1',
  firstSeenAt: '2026-05-01T00:00:00.000Z',
  conversationCount: 3,
  verified: false,
  ...overrides,
})

const requestContext = (overrides: Partial<ConversationRequestContext> = {}): ConversationRequestContext => ({
  clientIp: '203.0.113.4',
  country: 'US',
  region: 'CA',
  city: 'San Francisco',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  acceptLanguage: 'en-US,en;q=0.9',
  observedVia: 'edge_proof',
  ...overrides,
})

describe('buildVisitorPanelViewModel', () => {
  it('returns null when the conversation has neither a visitor nor a request context', () => {
    expect(buildVisitorPanelViewModel({ visitor: null, requestContext: null, entryPageUrl: null, entryReferrer: null }))
      .toBeNull()
  })

  it('maps every field when both a visitor and a full request context are present', () => {
    const viewModel = buildVisitorPanelViewModel({
      visitor: visitor(),
      requestContext: requestContext(),
      entryPageUrl: 'https://example.com/pricing',
      entryReferrer: 'https://google.com/search',
    })

    expect(viewModel).toMatchObject({
      visitorId: 'visitor-1',
      firstSeenAt: '2026-05-01T00:00:00.000Z',
      conversationCount: 3,
      verified: false,
      country: 'US',
      region: 'CA',
      city: 'San Francisco',
      browser: 'Chrome',
      os: 'Windows',
      language: 'en',
      entryPageUrl: 'https://example.com/pricing',
      referrer: 'https://google.com/search',
      clientIp: '203.0.113.4',
      unverifiedRequestFacts: false,
      previousConversationsTotal: 2,
      showSeeAllPreviousConversations: false,
    })
  })

  it('reports null request-derived fields, not undefined, when there is a visitor but no request context', () => {
    const viewModel = buildVisitorPanelViewModel({
      visitor: visitor({ conversationCount: 1 }),
      requestContext: null,
      entryPageUrl: null,
      entryReferrer: null,
    })

    expect(viewModel).toMatchObject({
      visitorId: 'visitor-1',
      country: null,
      browser: null,
      os: null,
      language: null,
      clientIp: null,
      previousConversationsTotal: 0,
      showSeeAllPreviousConversations: false,
    })
  })

  it('reports null visitor fields when there is a request context but no visitor', () => {
    const viewModel = buildVisitorPanelViewModel({
      visitor: null,
      requestContext: requestContext(),
      entryPageUrl: null,
      entryReferrer: null,
    })

    expect(viewModel).toMatchObject({
      visitorId: null,
      firstSeenAt: null,
      conversationCount: null,
      verified: null,
      previousConversationsTotal: null,
      showSeeAllPreviousConversations: false,
    })
  })

  it('flags unverified request facts when observedVia is unproven', () => {
    const viewModel = buildVisitorPanelViewModel({
      visitor: null,
      requestContext: requestContext({ observedVia: 'unproven', country: null, city: null, region: null, clientIp: null, userAgent: null, acceptLanguage: null }),
      entryPageUrl: null,
      entryReferrer: null,
    })

    expect(viewModel?.unverifiedRequestFacts).toBe(true)
  })

  it('shows "see all" once previous conversations exceed the five listed directly', () => {
    const viewModel = buildVisitorPanelViewModel({
      visitor: visitor({ conversationCount: 7 }),
      requestContext: null,
      entryPageUrl: null,
      entryReferrer: null,
    })

    expect(viewModel?.previousConversationsTotal).toBe(6)
    expect(viewModel?.showSeeAllPreviousConversations).toBe(true)
  })

  it('does not show "see all" at exactly five previous conversations', () => {
    const viewModel = buildVisitorPanelViewModel({
      visitor: visitor({ conversationCount: 6 }),
      requestContext: null,
      entryPageUrl: null,
      entryReferrer: null,
    })

    expect(viewModel?.previousConversationsTotal).toBe(5)
    expect(viewModel?.showSeeAllPreviousConversations).toBe(false)
  })
})
