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

export interface ListLowQualityTurnsOptions {
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
