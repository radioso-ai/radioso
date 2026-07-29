import { request } from './api-client'
import { withQuery } from './api-query'

export type QualitySkillStatus =
  | 'active'
  | 'paused'
  | 'awaiting_confirmation'
  | 'awaiting_tool'
  | 'completed'
  | 'cancelled'
  | 'expired'
  | 'failed'
export type FeedbackValue = 'up' | 'down'
export type QualityTriageState = 'open' | 'acknowledged' | 'resolved' | 'dismissed'

/**
 * Operator triage signals. The backend owns the predicate behind each id (see
 * `modules/quality/domain/qualitySignals.ts`), so the dashboard never has to
 * reconstruct one from the skill catalog.
 */
export const QUALITY_SIGNAL_IDS = [
  'negative_feedback',
  'grounding_gaps',
  'slow_responses',
  'skill_failures',
] as const

export type QualitySignalId = (typeof QUALITY_SIGNAL_IDS)[number]

export const QUALITY_STATS_RANGES = ['7d', '30d'] as const

export type QualityStatsRange = (typeof QUALITY_STATS_RANGES)[number]

export interface QualityTriageRecord {
  state: QualityTriageState
  reason: string | null
  updatedAt: string | null
}

export interface QualityActionFilter {
  skillName: string
  outcome: string
}

export interface QualityFeedbackSummary {
  upCount: number
  downCount: number
  comments: Array<{
    value: FeedbackValue
    comment: string
    createdAt: string
  }>
}

export interface LowQualityTurn {
  assistantMessageId: string
  conversationId: string
  agentId: string | null
  agentName: string | null
  channel: string | null
  question: string | null
  answerPreview: string
  skillName: string | null
  skillOutcome: string | null
  skillStatus: string | null
  totalLatencyMs: number | null
  createdAt: string
  feedback: QualityFeedbackSummary
  triage: QualityTriageRecord
}

export interface LowQualityTurnsPage {
  items: LowQualityTurn[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}

/** A numerator with the population it is defined over. `rate` is null when the population is empty. */
export interface QualityStatsMetric {
  count: number
  denominator: number
  rate: number | null
}

export interface QualityStatsWindow {
  /** ISO 8601, inclusive. */
  from: string
  /** ISO 8601, exclusive. */
  to: string
  turnCount: number
  grounded: QualityStatsMetric
  negativeFeedback: QualityStatsMetric
  skillFailures: QualityStatsMetric
}

export interface QualityStatsBucket {
  /** YYYY-MM-DD, one UTC day, zero-filled across the window. */
  date: string
  turnCount: number
  grounded: QualityStatsMetric
  negativeFeedback: QualityStatsMetric
  skillFailures: QualityStatsMetric
}

export interface QualityStats {
  range: QualityStatsRange
  filters: { agentId?: string; channel?: string }
  current: QualityStatsWindow
  /** Equal length, immediately preceding `current`. */
  previous: QualityStatsWindow
  /** Current window only, one entry per UTC day. */
  buckets: QualityStatsBucket[]
  /** Active-triage counts, all-time and range-independent — what the signal chips display. */
  backlog: Record<QualitySignalId, number>
}

export interface GetQualityStatsOptions {
  range?: QualityStatsRange
  agentId?: string
  channel?: string
}

export interface ListLowQualityTurnsOptions {
  signal?: QualitySignalId
  actions?: QualityActionFilter[]
  statuses?: QualitySkillStatus[]
  feedback?: FeedbackValue[]
  triageStates?: QualityTriageState[]
  hasComment?: boolean
  minTotalLatencyMs?: number
  maxTotalLatencyMs?: number
  from?: string
  to?: string
  offset?: number
  limit?: number
}

const encodeActions = (actions: QualityActionFilter[] | undefined): string | undefined => {
  if (!actions || actions.length === 0) {
    return undefined
  }
  return actions.map((action) => `${action.skillName}:${action.outcome}`).join(',')
}

export const qualityApi = {
  async listTurns(options: ListLowQualityTurnsOptions = {}): Promise<LowQualityTurnsPage> {
    const query: Record<string, string | undefined> = {
      signal: options.signal,
      actions: encodeActions(options.actions),
      statuses: options.statuses && options.statuses.length > 0 ? options.statuses.join(',') : undefined,
      feedback: options.feedback && options.feedback.length > 0 ? options.feedback.join(',') : undefined,
      triage: options.triageStates && options.triageStates.length > 0 ? options.triageStates.join(',') : undefined,
      hasComment: options.hasComment === undefined ? undefined : String(options.hasComment),
      minTotalLatencyMs: options.minTotalLatencyMs === undefined ? undefined : String(options.minTotalLatencyMs),
      maxTotalLatencyMs: options.maxTotalLatencyMs === undefined ? undefined : String(options.maxTotalLatencyMs),
      from: options.from,
      to: options.to,
      offset: options.offset === undefined ? undefined : String(options.offset),
      limit: options.limit === undefined ? undefined : String(options.limit),
    }
    const path = withQuery('/quality/turns', query)
    return request<LowQualityTurnsPage>(path, { method: 'GET' }, { withApiToken: true })
  },

  async getStats(options: GetQualityStatsOptions = {}): Promise<QualityStats> {
    const path = withQuery('/quality/stats', {
      range: options.range,
      agentId: options.agentId,
      channel: options.channel,
    })
    return request<QualityStats>(path, { method: 'GET' }, { withApiToken: true })
  },

  async setTriageState(
    assistantMessageId: string,
    input: { state: QualityTriageState; reason?: string | null },
  ): Promise<QualityTriageRecord> {
    return request<QualityTriageRecord>(
      `/quality/turns/${encodeURIComponent(assistantMessageId)}/triage`,
      { method: 'PUT', body: JSON.stringify(input) },
      { withApiToken: true },
    )
  },
}
