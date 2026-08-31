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
export const QUALITY_RESOLVED_REASONS = [
  'knowledge_gap',
  'retrieval_issue',
  'agent_behavior',
  'platform_bug',
  'other',
] as const
export const QUALITY_NOT_ACTIONABLE_REASONS = [
  'expected_behavior',
  'out_of_scope',
  'invalid_feedback',
  'other',
] as const
export const QUALITY_RESOLUTION_REASONS = [
  'knowledge_gap',
  'retrieval_issue',
  'agent_behavior',
  'platform_bug',
  'expected_behavior',
  'out_of_scope',
  'invalid_feedback',
  'other',
] as const
export type QualityResolvedReason = (typeof QUALITY_RESOLVED_REASONS)[number]
export type QualityNotActionableReason = (typeof QUALITY_NOT_ACTIONABLE_REASONS)[number]
export type QualityResolutionReason = (typeof QUALITY_RESOLUTION_REASONS)[number]
export type QualityResolutionBreakdownReason = QualityResolutionReason | 'unspecified'
export interface QualityResolution {
  reason: QualityResolutionReason
  note: string | null
}
export const GROUNDING_VERDICTS = ['grounded', 'degraded', 'no_support'] as const
export type GroundingVerdict = (typeof GROUNDING_VERDICTS)[number]
export interface GroundingDiagnostic {
  verdict: GroundingVerdict
  claimCount: number
  sourcedClaimCount: number
  unsourcedClaimCount: number
  invalidSourceCount: number
}

/**
 * Operator triage signals. The backend owns the predicate behind each id (see
 * `modules/quality/domain/qualitySignals.ts`), so the dashboard never has to
 * reconstruct one from the skill catalog.
 */
export const QUALITY_SIGNAL_IDS = [
  'negative_feedback',
  'grounding_gaps',
  'skill_failures',
] as const

export type QualitySignalId = (typeof QUALITY_SIGNAL_IDS)[number]

export const QUALITY_STATS_RANGES = ['7d', '30d'] as const

export type QualityStatsRange = (typeof QUALITY_STATS_RANGES)[number]

export interface QualityTriageRecord {
  state: QualityTriageState
  version: number
  resolution: QualityResolution | null
  legacyReason: string | null
  closedAt: string | null
  updatedAt: string | null
}

export const getQualityTriageConflict = (error: unknown): QualityTriageRecord | null => {
  if (!error || typeof error !== 'object' || !('status' in error) || error.status !== 409) {
    return null
  }
  if (!('error' in error) || !error.error || typeof error.error !== 'object') {
    return null
  }
  const details = 'details' in error.error ? error.error.details : null
  if (!details || typeof details !== 'object' || !('current' in details)) {
    return null
  }
  const current = details.current
  if (
    !current
    || typeof current !== 'object'
    || !('version' in current)
    || typeof current.version !== 'number'
    || !('state' in current)
    || typeof current.state !== 'string'
  ) {
    return null
  }
  return current as QualityTriageRecord
}

export interface QualityVerification {
  caseId: string
  caseStatus: 'pending' | 'passing' | 'failing' | 'error'
  latestRunStatus: 'pass' | 'fail' | 'error' | 'recorded' | null
  latestRunAt: string | null
}

export interface QualityActionFilter {
  skillName: string
  outcome: string
}

export interface QualityFeedbackSummary {
  upCount: number
  downCount: number
  latestDownUpdatedAt: string | null
  comments: Array<{
    value: FeedbackValue
    comment: string
    createdAt: string
    updatedAt: string
  }>
}

export interface LowQualityTurn {
  assistantMessageId: string
  conversationId: string
  agentId: string | null
  agentName: string | null
  agentInternalName: string | null
  channel: string | null
  question: string | null
  answerPreview: string
  skillName: string | null
  skillOutcome: string | null
  skillStatus: string | null
  totalLatencyMs: number | null
  grounding: GroundingDiagnostic | null
  createdAt: string
  feedback: QualityFeedbackSummary
  triage: QualityTriageRecord
  verification: QualityVerification | null
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
  resolutionBreakdown: Array<{
    state: 'resolved' | 'dismissed'
    reason: QualityResolutionBreakdownReason
    count: number
  }>
}

export interface GetQualityStatsOptions {
  range?: QualityStatsRange
  agentId?: string
  channel?: string
}

export interface ListLowQualityTurnsOptions {
  /**
   * One signal or several. Several means "any of these" server-side, which is how the
   * queue asks for everything worth reviewing without a second vocabulary for it.
   */
  signal?: QualitySignalId | readonly QualitySignalId[]
  actions?: QualityActionFilter[]
  statuses?: QualitySkillStatus[]
  feedback?: FeedbackValue[]
  triageStates?: QualityTriageState[]
  resolutionReasons?: QualityResolutionBreakdownReason[]
  sort?: 'turn_created_at' | 'negative_feedback_updated_at'
  activeNegativeFeedbackOnly?: boolean
  hasComment?: boolean
  minTotalLatencyMs?: number
  maxTotalLatencyMs?: number
  groundingVerdict?: GroundingVerdict | readonly GroundingVerdict[]
  hasUnsourcedClaims?: boolean
  hasInvalidSources?: boolean
  from?: string
  to?: string
  resolutionFrom?: string
  resolutionTo?: string
  offset?: number
  limit?: number
}

const encodeSignals = (
  signal: QualitySignalId | readonly QualitySignalId[] | undefined,
): string | undefined => {
  if (signal === undefined) {
    return undefined
  }
  if (typeof signal === 'string') {
    return signal
  }
  return signal.length > 0 ? signal.join(',') : undefined
}

const encodeGroundingVerdicts = (
  verdict: GroundingVerdict | readonly GroundingVerdict[] | undefined,
): string | undefined => {
  if (verdict === undefined) return undefined
  return typeof verdict === 'string' ? verdict : verdict.length > 0 ? verdict.join(',') : undefined
}

const encodeActions = (actions: QualityActionFilter[] | undefined): string | undefined => {
  if (!actions || actions.length === 0) {
    return undefined
  }
  return actions.map((action) => `${action.skillName}:${action.outcome}`).join(',')
}

export const qualityApi = {
  async listTurns(options: ListLowQualityTurnsOptions = {}, signal?: AbortSignal): Promise<LowQualityTurnsPage> {
    const query: Record<string, string | undefined> = {
      signal: encodeSignals(options.signal),
      groundingVerdict: encodeGroundingVerdicts(options.groundingVerdict),
      hasUnsourcedClaims: options.hasUnsourcedClaims === undefined ? undefined : String(options.hasUnsourcedClaims),
      hasInvalidSources: options.hasInvalidSources === undefined ? undefined : String(options.hasInvalidSources),
      actions: encodeActions(options.actions),
      statuses: options.statuses && options.statuses.length > 0 ? options.statuses.join(',') : undefined,
      feedback: options.feedback && options.feedback.length > 0 ? options.feedback.join(',') : undefined,
      triage: options.triageStates && options.triageStates.length > 0 ? options.triageStates.join(',') : undefined,
      resolutionReason: options.resolutionReasons && options.resolutionReasons.length > 0
        ? options.resolutionReasons.join(',')
        : undefined,
      sort: options.sort,
      activeNegativeFeedbackOnly: options.activeNegativeFeedbackOnly === undefined
        ? undefined
        : String(options.activeNegativeFeedbackOnly),
      hasComment: options.hasComment === undefined ? undefined : String(options.hasComment),
      minTotalLatencyMs: options.minTotalLatencyMs === undefined ? undefined : String(options.minTotalLatencyMs),
      maxTotalLatencyMs: options.maxTotalLatencyMs === undefined ? undefined : String(options.maxTotalLatencyMs),
      from: options.from,
      to: options.to,
      resolutionFrom: options.resolutionFrom,
      resolutionTo: options.resolutionTo,
      offset: options.offset === undefined ? undefined : String(options.offset),
      limit: options.limit === undefined ? undefined : String(options.limit),
    }
    const path = withQuery('/quality/turns', query)
    return request<LowQualityTurnsPage>(path, { method: 'GET', ...(signal ? { signal } : {}) }, { withSession: true })
  },

  async getStats(options: GetQualityStatsOptions = {}, signal?: AbortSignal): Promise<QualityStats> {
    const path = withQuery('/quality/stats', {
      range: options.range,
      agentId: options.agentId,
      channel: options.channel,
    })
    return request<QualityStats>(path, { method: 'GET', ...(signal ? { signal } : {}) }, { withSession: true })
  },

  async setTriageState(
    assistantMessageId: string,
    input: {
      state: QualityTriageState
      expectedVersion: number
      resolution?: { reason: QualityResolutionReason; note?: string | null }
      /** Deprecated compatibility field. Never interpreted as a structured reason. */
      reason?: string | null
    },
  ): Promise<QualityTriageRecord> {
    return request<QualityTriageRecord>(
      `/quality/turns/${encodeURIComponent(assistantMessageId)}/triage`,
      { method: 'PUT', body: JSON.stringify(input) },
      { withSession: true },
    )
  },
}
