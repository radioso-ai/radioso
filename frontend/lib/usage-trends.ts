import type { UsageTrendBucket, UsageTrendsResponse } from '@/lib/api-types'

export type UsageTrendGranularity = 'day' | 'week' | 'month'

export interface UsageTrendQueryState {
  from: string
  to: string
  granularity: UsageTrendGranularity
  workspaceId?: string
  agentId?: string
}

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
})

const monthFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  year: 'numeric',
})

const toDateOnly = (date: Date): string => date.toISOString().slice(0, 10)

export const defaultUsageTrendQuery = (now: Date = new Date()): UsageTrendQueryState => {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const start = new Date(end.getTime())
  start.setUTCDate(start.getUTCDate() - 29)
  return {
    from: toDateOnly(start),
    to: toDateOnly(end),
    granularity: 'day',
  }
}

export const formatUsageTrendBucketLabel = (bucket: UsageTrendBucket, granularity: UsageTrendGranularity): string => {
  const start = new Date(bucket.periodStart)
  if (granularity === 'month') {
    return monthFormatter.format(start)
  }
  return dateFormatter.format(start)
}

export const summarizeUsageTrends = (response: UsageTrendsResponse) => response.buckets.reduce(
  (totals, bucket) => ({
    conversationsCreated: totals.conversationsCreated + bucket.conversationsCreated,
    messages: {
      total: totals.messages.total + bucket.messages.total,
      user: totals.messages.user + bucket.messages.user,
      assistant: totals.messages.assistant + bucket.messages.assistant,
    },
    tokens: {
      input: totals.tokens.input + bucket.tokens.input,
      output: totals.tokens.output + bucket.tokens.output,
      total: totals.tokens.total + bucket.tokens.total,
    },
  }),
  {
    conversationsCreated: 0,
    messages: { total: 0, user: 0, assistant: 0 },
    tokens: { input: 0, output: 0, total: 0 },
  },
)

export const findPeakUsageTrendBucket = (response: UsageTrendsResponse): UsageTrendBucket | null => {
  if (response.buckets.length === 0) {
    return null
  }
  return response.buckets.reduce((peak, bucket) => (
    bucket.tokens.total > peak.tokens.total ? bucket : peak
  ), response.buckets[0])
}
