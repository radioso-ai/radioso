import { request } from './api-client'
import { withQuery } from './api-query'
import type { LowQualityTurnsPage } from './api-quality'

/**
 * Frontend adapter for the Content plan reads. The frontend does not classify
 * turns, rank topics, or compute grounding rates — those are backend-owned. This
 * module mirrors the locked contract in
 * `backend/src/modules/contentPlanning/contracts/index.ts` so the fetch layer and
 * the rendered types stay in one vocabulary.
 */

export const CONTENT_PLAN_VIEWS = ['opportunities', 'all_interests'] as const
export type ContentPlanView = (typeof CONTENT_PLAN_VIEWS)[number]

export const CONTENT_PLAN_PROJECTION_STATES = [
  'bootstrapping',
  'ready',
  'updating',
  'delayed',
  'reprojecting',
  'degraded',
  'budget_paused',
] as const
export type ContentPlanProjectionState = (typeof CONTENT_PLAN_PROJECTION_STATES)[number]

export const CONTENT_PLAN_TRENDS = [
  'new',
  'rising',
  'steady',
  'falling',
  'insufficient_data',
] as const
export type ContentPlanTrend = (typeof CONTENT_PLAN_TRENDS)[number]

export const CONTENT_PLAN_EVIDENCE_STRENGTHS = ['none', 'low', 'medium', 'high'] as const
export type ContentPlanEvidenceStrength = (typeof CONTENT_PLAN_EVIDENCE_STRENGTHS)[number]

export const CONTENT_PLAN_RECOMMENDATION_ACTIONS = [
  'add_content',
  'review_existing_content',
  'investigate_retrieval',
  'monitor',
] as const
export type ContentPlanRecommendationAction = (typeof CONTENT_PLAN_RECOMMENDATION_ACTIONS)[number]

export const CONTENT_PLAN_ENRICHMENT_STATES = [
  'pending',
  'ready',
  'stale',
  'unavailable',
  'outside_analysis_cap',
] as const
export type ContentPlanEnrichmentState = (typeof CONTENT_PLAN_ENRICHMENT_STATES)[number]

export const CONTENT_PLAN_CORPUS_STATES = ['pending', 'ready', 'unavailable', 'stale'] as const
export type ContentPlanCorpusState = (typeof CONTENT_PLAN_CORPUS_STATES)[number]

export const CONTENT_PLAN_HEADLINE_STATES = [
  'measured',
  'insufficient_measured_turns',
  'unmeasured',
] as const
export type ContentPlanHeadlineState = (typeof CONTENT_PLAN_HEADLINE_STATES)[number]

export const CONTENT_PLAN_PRIORITY_REASONS = [
  'active_no_support',
  'active_degraded',
  'high_demand',
  'new_demand',
  'rising_demand',
] as const
export type ContentPlanPriorityReason = (typeof CONTENT_PLAN_PRIORITY_REASONS)[number]

export const CONTENT_PLAN_EMERGING_STATES = [
  'emerging',
  'awaiting_context',
  'awaiting_embedding',
] as const
export type ContentPlanEmergingState = (typeof CONTENT_PLAN_EMERGING_STATES)[number]

export const CONTENT_PLAN_SUGGESTED_SHAPES = [
  'guide',
  'faq',
  'reference',
  'policy',
  'troubleshooting',
] as const
export type ContentPlanSuggestedShape = (typeof CONTENT_PLAN_SUGGESTED_SHAPES)[number]

export const CONTENT_PLAN_MEMBER_TURN_WINDOWS = ['current', 'comparison', 'both'] as const
export type ContentPlanMemberTurnWindow = (typeof CONTENT_PLAN_MEMBER_TURN_WINDOWS)[number]

export type ContentPlanRepresentativeGroundingVerdict =
  | 'grounded'
  | 'degraded'
  | 'no_support'
  | 'not_evaluated'

export interface ContentPlanWindow {
  from: string
  to: string
}

export interface ContentPlanProjection {
  state: ContentPlanProjectionState
  processedThrough: string | null
  processingLagSeconds: number | null
  pendingEmbeddingCount: number
  pendingAssignmentCount: number
  pendingEnrichmentTopicCount: number
  processedCount: number | null
  totalCount: number | null
  embeddingSpaceFingerprint: string | null
  reason: string | null
}

export interface ContentPlanGroundingSummary {
  evaluatedAnswerCount: number
  groundedAnswerCount: number
  degradedAnswerCount: number
  noSupportAnswerCount: number
  notEvaluatedAnswerCount: number
  reducedOrNoSupportRate: number | null
  headlineState: ContentPlanHeadlineState
}

export interface ContentPlanSummary {
  questionCount: number
  conversationCount: number
  matureTopicCount: number
  emergingQuestionCount: number
  opportunityCount: number
  grounding: ContentPlanGroundingSummary
}

export interface ContentPlanTopicGrounding {
  groundedAnswerCount: number
  degradedAnswerCount: number
  noSupportAnswerCount: number
  notEvaluatedAnswerCount: number
  evaluatedAnswerCount: number
  reducedOrNoSupportRate: number | null
  headlineState: ContentPlanHeadlineState
}

export interface ContentPlanTopicDemand {
  currentQuestionCount: number
  comparisonQuestionCount: number
  currentConversationCount: number
  comparisonConversationCount: number
  currentShare: number | null
  absoluteChange: number
  trend: ContentPlanTrend
}

export interface ContentPlanTopicEvidence {
  strength: ContentPlanEvidenceStrength
  evaluatedConversationCount: number
  activeGapConversationCount: number
}

export interface ContentPlanTopicOpportunity {
  credible: boolean
  priorityReasons: ContentPlanPriorityReason[]
}

export interface ContentPlanRecommendation {
  action: ContentPlanRecommendationAction | null
  state: ContentPlanEnrichmentState
  rationale: string | null
  suggestedTitle: string | null
  questionsToAnswer: string[]
  suggestedShape: ContentPlanSuggestedShape | null
  evidenceStatement: string | null
  factsMustBeVerified: true
}

export interface ContentPlanCorpusEvidence {
  state: ContentPlanCorpusState
  relatedDocumentCount: number
  actionRuleVersion: 1
}

export interface ContentPlanTopicSummary {
  id: string
  lifecycle: 'mature'
  label: string | null
  description: string | null
  labelState: ContentPlanEnrichmentState
  demand: ContentPlanTopicDemand
  grounding: ContentPlanTopicGrounding
  evidence: ContentPlanTopicEvidence
  opportunity: ContentPlanTopicOpportunity
  recommendation: ContentPlanRecommendation
  corpusEvidence: ContentPlanCorpusEvidence
  affected: { agentCount: number; channelCount: number }
  updatedAt: string
}

export interface ContentPlanEmergingQuestion {
  observationId: string
  question: string | null
  sourceAvailable: boolean
  conversationId: string | null
  assistantMessageId: string | null
  questionCount: number
  conversationCount: number
  observedAt: string
  state: ContentPlanEmergingState
}

export interface ContentPlanPage {
  range: '30d'
  window: ContentPlanWindow
  comparisonWindow: ContentPlanWindow
  asOf: string
  projection: ContentPlanProjection
  summary: ContentPlanSummary
  rankingVersion: 1
  recommendedTopicId: string | null
  items: ContentPlanTopicSummary[]
  emerging: ContentPlanEmergingQuestion[]
  nextCursor: string | null
}

export interface ContentPlanRepresentativeQuestion {
  observationId: string
  question: string | null
  sourceAvailable: boolean
  conversationId: string | null
  userMessageId: string | null
  assistantMessageId: string | null
  observedAt: string
  groundingVerdict: ContentPlanRepresentativeGroundingVerdict
}

export interface ContentPlanRelatedDocument {
  id: string
  title: string
  updatedAt: string
  possibleRelevance: number
  evidence: {
    existedBeforeGap: boolean
    retrievedByGapAnswers: boolean
    citedByGapAnswers: boolean
    changedAfterGap: boolean
  }
}

export interface ContentPlanAffectedAgent {
  id: string
  name: string | null
  questionCount: number
}

export interface ContentPlanAffectedChannel {
  channel: string | null
  questionCount: number
}

export interface ContentPlanTopicDecision {
  action: ContentPlanRecommendationAction | null
  actionState: 'ready' | 'unavailable' | 'pending' | 'stale'
  reasons: string[]
}

export interface ContentPlanTopicDetail {
  asOf: string
  window: ContentPlanWindow
  comparisonWindow: ContentPlanWindow
  projection: ContentPlanProjection
  canonicalTopicId: string
  redirectedFromTopicId: string | null
  topic: ContentPlanTopicSummary
  decision: ContentPlanTopicDecision
  representativeQuestions: ContentPlanRepresentativeQuestion[]
  relatedDocuments: ContentPlanRelatedDocument[]
  affectedAgents: ContentPlanAffectedAgent[]
  affectedChannels: ContentPlanAffectedChannel[]
}

export interface ListContentPlanOptions {
  view?: ContentPlanView
  cursor?: string
  limit?: number
}

export interface ListTopicTurnsOptions {
  window?: ContentPlanMemberTurnWindow
  page?: number
  pageSize?: number
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export const isContentPlanTopicId = (value: string): boolean => UUID_PATTERN.test(value)

const getStatus = (error: unknown): number | null => {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const status = (error as { status?: unknown }).status
    return typeof status === 'number' ? status : null
  }
  return null
}

export const contentPlanApi = {
  async list(options: ListContentPlanOptions = {}): Promise<ContentPlanPage> {
    const path = withQuery('/quality/content-plan', {
      view: options.view ?? 'opportunities',
      cursor: options.cursor,
      limit: options.limit === undefined ? undefined : String(options.limit),
    })
    return request<ContentPlanPage>(path, { method: 'GET' }, { withApiToken: true })
  },

  async getTopic(topicId: string): Promise<ContentPlanTopicDetail | null> {
    if (!isContentPlanTopicId(topicId)) {
      throw new Error(`Invalid content plan topic id: ${topicId}`)
    }
    try {
      return await request<ContentPlanTopicDetail>(
        `/quality/content-plan/topics/${topicId}`,
        { method: 'GET' },
        { withApiToken: true },
      )
    } catch (caught) {
      if (getStatus(caught) === 404) {
        return null
      }
      throw caught
    }
  },

  async listTopicTurns(
    topicId: string,
    options: ListTopicTurnsOptions = {},
  ): Promise<LowQualityTurnsPage | null> {
    if (!isContentPlanTopicId(topicId)) {
      throw new Error(`Invalid content plan topic id: ${topicId}`)
    }
    const path = withQuery(`/quality/content-plan/topics/${topicId}/turns`, {
      window: options.window ?? 'current',
      page: options.page === undefined ? undefined : String(options.page),
      pageSize: options.pageSize === undefined ? undefined : String(options.pageSize),
    })
    try {
      return await request<LowQualityTurnsPage>(
        path,
        { method: 'GET' },
        { withApiToken: true },
      )
    } catch (caught) {
      if (getStatus(caught) === 404) {
        return null
      }
      throw caught
    }
  },
}

export type ContentPlanApi = typeof contentPlanApi
