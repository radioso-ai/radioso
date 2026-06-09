import { describe, expect, it } from 'vitest'

import {
  defaultUsageTrendQuery,
  findPeakUsageTrendBucket,
  formatUsageTrendBucketLabel,
  isAgentFilterScopedOut,
  summarizeUsageTrends,
} from '@/lib/usage-trends'
import type { UsageTrendsResponse } from '@/lib/api-types'

const response: UsageTrendsResponse = {
  granularity: 'day',
  from: '2026-06-01',
  to: '2026-06-02',
  filters: { workspaceId: null, agentId: null },
  buckets: [
    {
      periodStart: '2026-06-01T00:00:00.000Z',
      periodEnd: '2026-06-02T00:00:00.000Z',
      conversationsCreated: 1,
      messages: { total: 3, user: 2, assistant: 1 },
      tokens: { input: 10, output: 15, total: 25 },
    },
    {
      periodStart: '2026-06-02T00:00:00.000Z',
      periodEnd: '2026-06-03T00:00:00.000Z',
      conversationsCreated: 2,
      messages: { total: 5, user: 2, assistant: 3 },
      tokens: { input: 30, output: 40, total: 70 },
    },
  ],
}

describe('usage trends helpers', () => {
  it('creates a 30-day UTC default query ending today', () => {
    expect(defaultUsageTrendQuery(new Date('2026-06-09T17:45:00.000Z'))).toEqual({
      from: '2026-05-11',
      to: '2026-06-09',
      granularity: 'day',
    })
  })

  it('summarizes response buckets without inspecting visual markup', () => {
    expect(summarizeUsageTrends(response)).toEqual({
      conversationsCreated: 3,
      messages: { total: 8, user: 4, assistant: 4 },
      tokens: { input: 40, output: 55, total: 95 },
    })
  })

  it('finds the peak token bucket', () => {
    expect(findPeakUsageTrendBucket(response)?.periodStart).toBe('2026-06-02T00:00:00.000Z')
  })

  it('formats month buckets with month and year', () => {
    expect(formatUsageTrendBucketLabel({
      ...response.buckets[0],
      periodStart: '2026-06-01T00:00:00.000Z',
    }, 'month')).toMatch(/Jun|June/)
  })
})

describe('isAgentFilterScopedOut', () => {
  it('keeps the agent filter available with no workspace filter', () => {
    expect(isAgentFilterScopedOut(undefined, 'ws-active')).toBe(false)
  })

  it('keeps the agent filter available for the active workspace', () => {
    expect(isAgentFilterScopedOut('ws-active', 'ws-active')).toBe(false)
  })

  it('disables the agent filter for a different workspace', () => {
    expect(isAgentFilterScopedOut('ws-other', 'ws-active')).toBe(true)
  })

  it('disables the agent filter for a specific workspace when no agents are loaded', () => {
    expect(isAgentFilterScopedOut('ws-other', undefined)).toBe(true)
  })
})
