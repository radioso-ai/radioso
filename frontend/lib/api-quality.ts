import { request } from './api-client'
import { withQuery } from './api-query'

export type AnswerOutcome = 'grounded_success' | 'no_context_refusal' | 'non_retrieval_response'
export type QualityConversationStatus = 'success' | 'failure'
export type FeedbackValue = 'up' | 'down'

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
  answerOutcome: AnswerOutcome | null
  conversationStatus: QualityConversationStatus | null
  totalLatencyMs: number | null
  createdAt: string
  feedback: QualityFeedbackSummary
}

export interface LowQualityTurnsPage {
  items: LowQualityTurn[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}

export interface ListLowQualityTurnsOptions {
  outcomes?: AnswerOutcome[]
  statuses?: QualityConversationStatus[]
  feedback?: FeedbackValue[]
  hasComment?: boolean
  minTotalLatencyMs?: number
  maxTotalLatencyMs?: number
  agentId?: string
  channel?: string
  from?: string
  to?: string
  offset?: number
  limit?: number
}

export const qualityApi = {
  async listTurns(options: ListLowQualityTurnsOptions = {}): Promise<LowQualityTurnsPage> {
    const query: Record<string, string | undefined> = {
      outcomes: options.outcomes && options.outcomes.length > 0 ? options.outcomes.join(',') : undefined,
      statuses: options.statuses && options.statuses.length > 0 ? options.statuses.join(',') : undefined,
      feedback: options.feedback && options.feedback.length > 0 ? options.feedback.join(',') : undefined,
      hasComment: options.hasComment === undefined ? undefined : String(options.hasComment),
      minTotalLatencyMs: options.minTotalLatencyMs === undefined ? undefined : String(options.minTotalLatencyMs),
      maxTotalLatencyMs: options.maxTotalLatencyMs === undefined ? undefined : String(options.maxTotalLatencyMs),
      agentId: options.agentId,
      channel: options.channel,
      from: options.from,
      to: options.to,
      offset: options.offset === undefined ? undefined : String(options.offset),
      limit: options.limit === undefined ? undefined : String(options.limit),
    }
    const path = withQuery('/quality/turns', query)
    return request<LowQualityTurnsPage>(path, { method: 'GET' }, { withApiToken: true })
  },
}
