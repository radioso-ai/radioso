import { describe, expect, it } from 'vitest'

import {
  dashboardQueryKeys,
  historyVariantForKey,
  isDashboardQueryFamily,
  isDashboardQueryKey,
} from '@/lib/dashboard-query-keys'
import type { QualityTurnsQueryInput } from '@/lib/dashboard-query-keys'

const workspaceId = 'workspace-a'

const qualityTurns = (overrides: Partial<QualityTurnsQueryInput> = {}) => dashboardQueryKeys.quality.turns(workspaceId, {
  ...overrides,
  page: overrides.page ?? 1,
  pageSize: overrides.pageSize ?? 25,
})

describe('dashboard query keys', () => {
  it('includes canonical workspace identity and every non-quality result discriminator', () => {
    const documents = dashboardQueryKeys.documents.list(workspaceId, { sourceId: 'source-a', page: 2, pageSize: 50 })
    expect(documents)
      .toEqual(['workspace', workspaceId, 'documents', 'list', 'source-a', 2, 50])
    for (const key of [
      dashboardQueryKeys.documents.list(workspaceId, { sourceId: 'source-b', page: 2, pageSize: 50 }),
      dashboardQueryKeys.documents.list(workspaceId, { sourceId: 'source-a', page: 3, pageSize: 50 }),
      dashboardQueryKeys.documents.list(workspaceId, { sourceId: 'source-a', page: 2, pageSize: 25 }),
    ]) expect(key).not.toEqual(documents)
    expect(dashboardQueryKeys.documents.crawlActivity(workspaceId, { recentSinceMinutes: 60 }))
      .not.toEqual(dashboardQueryKeys.documents.crawlActivity(workspaceId, { recentSinceMinutes: 120 }))
    const history = dashboardQueryKeys.history.list(workspaceId, { variant: 'contact', page: 3, pageSize: 20 })
    expect(history)
      .toEqual(['workspace', workspaceId, 'history', 'list', 'contact', 3, 20])
    for (const key of [
      dashboardQueryKeys.history.list(workspaceId, { variant: 'chat', page: 3, pageSize: 20 }),
      dashboardQueryKeys.history.list(workspaceId, { variant: 'contact', page: 4, pageSize: 20 }),
      dashboardQueryKeys.history.list(workspaceId, { variant: 'contact', page: 3, pageSize: 50 }),
    ]) expect(key).not.toEqual(history)
    const humanOwned = dashboardQueryKeys.attention.humanOwned(workspaceId, { pageSize: 25 })
    expect(humanOwned).not.toEqual(dashboardQueryKeys.attention.humanOwned(workspaceId, { pageSize: 50 }))
    const stats = dashboardQueryKeys.quality.stats(workspaceId, { range: '7d', agentId: 'agent-a', channel: 'web' })
    for (const key of [
      dashboardQueryKeys.quality.stats(workspaceId, { range: '30d', agentId: 'agent-a', channel: 'web' }),
      dashboardQueryKeys.quality.stats(workspaceId, { range: '7d', agentId: 'agent-b', channel: 'web' }),
      dashboardQueryKeys.quality.stats(workspaceId, { range: '7d', agentId: 'agent-a', channel: 'email' }),
    ]) expect(key).not.toEqual(stats)
  })

  it('omits searchParams entirely from the history key when not given, matching the pre-filter shape exactly', () => {
    const withoutSearchParams = dashboardQueryKeys.history.list(workspaceId, { variant: 'all', page: 1, pageSize: 50 })
    expect(withoutSearchParams).toEqual(['workspace', workspaceId, 'history', 'list', 'all', 1, 50])
  })

  it('distinguishes history keys by searchParams once one is given, and treats an empty object as its own key', () => {
    const noFilters = dashboardQueryKeys.history.list(workspaceId, { variant: 'all', page: 1, pageSize: 50, searchParams: {} })
    const withQ = dashboardQueryKeys.history.list(workspaceId, { variant: 'all', page: 1, pageSize: 50, searchParams: { q: 'refund' } })
    const withOutcome = dashboardQueryKeys.history.list(workspaceId, { variant: 'all', page: 1, pageSize: 50, searchParams: { outcome: 'completed' } })
    const withAgent = dashboardQueryKeys.history.list(workspaceId, { variant: 'all', page: 1, pageSize: 50, searchParams: { agentId: 'agent-a' } })
    const withSite = dashboardQueryKeys.history.list(workspaceId, { variant: 'all', page: 1, pageSize: 50, searchParams: { sourceOrigin: 'https://example.com' } })

    // Passing an (empty) searchParams object is itself a different key from omitting it —
    // the two are handled by different react-query cache entries even though they'd
    // currently produce the same server request.
    const withoutSearchParams = dashboardQueryKeys.history.list(workspaceId, { variant: 'all', page: 1, pageSize: 50 })
    expect(noFilters).not.toEqual(withoutSearchParams);
    [withQ, withOutcome, withAgent, withSite].forEach((key) => {
      expect(key).not.toEqual(noFilters)
    })
    expect(withQ).not.toEqual(withOutcome)
    expect(withAgent).not.toEqual(withSite)
  })

  it('normalizes scalar-or-array and all set-like quality filters, including action objects', () => {
    const first = qualityTurns({
      actions: [
        { skillName: 'skill-b', outcome: 'failed' },
        { skillName: 'skill-a', outcome: 'succeeded' },
        { skillName: 'skill-a', outcome: 'succeeded' },
      ],
      feedback: ['down', 'up', 'down'],
      groundingVerdict: ['grounded', 'no_support'],
      resolutionReasons: ['out_of_scope', 'platform_bug'],
      signal: ['negative_feedback', 'grounding_gaps'],
      statuses: ['failed', 'completed'],
      triageStates: ['acknowledged', 'open'],
    })
    const second = qualityTurns({
      actions: [
        { skillName: 'skill-a', outcome: 'succeeded' },
        { skillName: 'skill-b', outcome: 'failed' },
      ],
      feedback: ['up', 'down'],
      groundingVerdict: ['no_support', 'grounded'],
      resolutionReasons: ['platform_bug', 'out_of_scope'],
      signal: ['grounding_gaps', 'negative_feedback'],
      statuses: ['completed', 'failed'],
      triageStates: ['open', 'acknowledged'],
    })

    expect(first).toEqual(second)
    expect(qualityTurns({ signal: 'grounding_gaps' }))
      .toEqual(qualityTurns({ signal: ['grounding_gaps'] }))
  })

  it('keeps optional false distinct from absent and every scalar request discriminator distinct', () => {
    const base = qualityTurns()
    const changes = [
      qualityTurns({ activeNegativeFeedbackOnly: false }),
      qualityTurns({ hasComment: false }),
      qualityTurns({ hasUnsourcedClaims: false }),
      qualityTurns({ hasInvalidSources: false }),
      qualityTurns({ minTotalLatencyMs: 2_000 }),
      qualityTurns({ maxTotalLatencyMs: 5_000 }),
      qualityTurns({ from: '2025-01-01T00:00:00.000Z' }),
      qualityTurns({ to: '2025-01-02T00:00:00.000Z' }),
      qualityTurns({ resolutionFrom: '2025-01-01T00:00:00.000Z' }),
      qualityTurns({ resolutionTo: '2025-01-02T00:00:00.000Z' }),
      qualityTurns({ sort: 'negative_feedback_updated_at' }),
      qualityTurns({ page: 2 }),
      qualityTurns({ pageSize: 50 }),
    ]

    for (const key of changes) expect(key).not.toEqual(base)
  })

  it('recognizes only terminal, exact query families and history variants', () => {
    const history = dashboardQueryKeys.history.list(workspaceId, { variant: 'chat', page: 1, pageSize: 50 })
    expect(isDashboardQueryFamily(history, workspaceId, 'history/list')).toBe(true)
    expect(isDashboardQueryFamily(history, workspaceId, 'history' as never)).toBe(false)
    expect(isDashboardQueryKey(history, workspaceId)).toBe(true)
    expect(isDashboardQueryKey(['workspace', workspaceId, 'history', 'unknown'], workspaceId)).toBe(false)
    expect(historyVariantForKey(history, workspaceId)).toBe('chat')
    expect(historyVariantForKey(history, 'workspace-b')).toBeNull()
  })
})
