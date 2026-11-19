import { request, type ErrorResponse } from './api-client'
import type { components } from '../../typescript-sdk/src/generated/types'

type ApiSchemas = components['schemas']

export interface AudiencePulsePeriod {
  start: string
  end: string
}

export interface AudiencePulseWeeklyVolume {
  weekStart: string
  visitorQuestionCount: number
  conversationCount: number
}

export interface AudiencePulseCoverage {
  populationSize: number
  sampleSize: number
  sampled: boolean
  /**
   * How many of `populationSize` had a current, embedded facet the census could cluster.
   * Zero means topic analysis has not run over this window yet — a different statement
   * from a computed window that found no recurring pattern, which is why the view
   * branches on this rather than on `unclassifiedQuestionCount === populationSize`.
   */
  facetReadyQuestionCount: number
}

export interface AudiencePulseGroundingSummary {
  grounded: number
  degraded: number
  noSupport: number
  unknown: number
  contentGapEligible: number
}

export type AudiencePulseCoverageSummary = ApiSchemas['AudiencePulseSemanticCoverage']

export type AudiencePulseAnswerSummary = ApiSchemas['AudiencePulseAnswerSummary']

export interface AudiencePulseTopicTransition {
  kind: 'survived' | 'split' | 'merged' | 'emerged' | 'dissolved'
  parentTopicIds: string[]
  viaCentroidFallback: boolean
}

export interface AudiencePulseDissolvedTopic {
  id: string
  title: string
}

export interface AudiencePulseThemeEvidence {
  reference: string
  conversationId: string
  messageId: string
  /** The words the visitor typed, never the readings of photos the message carried. */
  question: string
  /** The photos the message carried; absent from an API deploy that predates the field, and then read as none. */
  questionPhotoCount?: number
  occurrenceCount: number
  answerCoverage?: ApiSchemas['AnswerCoverage']
  /** Absent only for an example from a report saved before answer coverage was recorded. */
  answerStatus?: ApiSchemas['AudiencePulseAnswerStatus']
}

export interface AudiencePulseTheme {
  id: string
  title: string
  description: string
  /** Exact count of population questions in this topic -- a census, never a sample. */
  memberCount: number
  previousMemberCount: number | null
  previousShare: number | null
  transition: AudiencePulseTopicTransition | null
  /** `memberCount` divided by the window population size. */
  share: number
  distinctQuestionCount: number
  weeklyPulse: Array<{ weekStart: string; count: number }>
  grounding: AudiencePulseGroundingSummary
  coverage?: AudiencePulseCoverageSummary
  /** Null only when an API older than the browser bundle sent no answer summary. */
  answers: AudiencePulseAnswerSummary | null
  evidence: AudiencePulseThemeEvidence[]
}

export interface AudiencePulseContentGap {
  themeId: string
  eligibleEvidenceCount: number
  distinctConversationCount: number
  /**
   * When an operator marked the topic "not for us"; null while it is in the queue. Read at request
   * time and changes no count. Absent from an API deploy that predates it.
   */
  dismissedAt?: string | null
  /** The newest document drafted from the topic that still exists. Absent from an older API deploy. */
  latestDraft?: ApiSchemas['AudiencePulseTopicDraft'] | null
}

export interface AudiencePulseRecommendation {
  id: string
  themeId: string
  title: string
  rationale: string
  questions: string[]
  evidenceReferences: string[]
  startDraft: { title: string; questions: string[] }
}

export interface AudiencePulseHydratedReport {
  period: AudiencePulsePeriod
  generatedAt: string
  /** Whether this report is the workspace's first topic census. */
  isFirstCensus: boolean
  narrativeGeneratedAt: string
  narrativeReuseCount: number
  /** Absent from an API deploy older than the materiality rule; only the report's producer owns that rule. */
  narrativeReuseMaxDrift?: number
  coverage: AudiencePulseCoverage
  weeklyVolume: AudiencePulseWeeklyVolume[]
  /** Absent when no narrative call ran because nothing in the window was facet-ready. */
  summary?: string
  dissolvedTopics: AudiencePulseDissolvedTopic[]
  themes: AudiencePulseTheme[]
  contentGaps: AudiencePulseContentGap[]
  recommendations: AudiencePulseRecommendation[]
  caveats: string[]
  unclassifiedQuestionCount: number
  /* Whole-window counts. Absent from a report saved before they existed, and then hidden. */
  totals?: ApiSchemas['AudiencePulseReportTotals']
  /** One entry per UTC day the period touches, zero-filled and ascending. */
  dailyVolume?: ApiSchemas['AudiencePulseDailyVolume'][]
  /** The 30 days before `period.start`; null when they had no eligible question. */
  previousPeriod?: ApiSchemas['AudiencePulsePreviousPeriod'] | null
  /** By the conversation's source channel, the largest first. */
  channels?: ApiSchemas['AudiencePulseChannelVolume'][]
  /** `generatedAt` of the earlier report each topic's previous count comes from. */
  previousGeneratedAt?: string | null
}

type AudiencePulseMessageSource =
  | 'customer'
  | 'ai_agent'
  | 'human_agent'
  | 'human_agent_on_behalf_of_ai_agent'
  | 'system'

export interface AudiencePulseEvidenceAnchorSource {
  messageId: string
  role: 'user'
  source: 'customer'
  /** The words the visitor typed, never the readings of photos the message carried. */
  content: string
  /** The photos the message carried; absent from an API deploy that predates the field, and then read as none. */
  photoCount?: number
  createdAt: string
}

export interface AudiencePulseEvidenceAnchorNextAssistant {
  messageId: string
  role: 'assistant'
  source: AudiencePulseMessageSource
  content: string
  createdAt: string
}

/**
 * A deliberately small, server-authorized evidence window. The browser sends
 * source identifiers in a POST body; they are never persisted in a dashboard
 * URL or loaded by paging through an entire conversation.
 */
export interface AudiencePulseEvidenceAnchorResponse {
  conversationId: string
  source: AudiencePulseEvidenceAnchorSource
  nextAssistant: AudiencePulseEvidenceAnchorNextAssistant | null
}

export type AudiencePulseReadResponse =
  | { kind: 'not_generated' }
  | { kind: 'completed'; report: AudiencePulseHydratedReport }

export type AudiencePulseRefreshResponse =
  | { kind: 'no_traffic'; period: AudiencePulsePeriod; weeklyVolume: AudiencePulseWeeklyVolume[] }
  | { kind: 'preparing' }
  | { kind: 'unavailable'; reason: 'provider' | 'validation' | 'census' | 'cancelled' }
  | { kind: 'completed'; report: AudiencePulseHydratedReport }

type OptionalTopicTransitionFields = 'previousMemberCount' | 'previousShare' | 'transition'
type OptionalReportFields = 'dissolvedTopics' | 'isFirstCensus' | 'narrativeGeneratedAt' | 'narrativeReuseCount'

/**
 * What an API deploy older than the topic-transition contract sends. The browser
 * bundle and the API are released separately, so the fields a newer view reads can
 * be missing from a response that is otherwise valid.
 */
type WireAudiencePulseTheme =
  Omit<AudiencePulseTheme, OptionalTopicTransitionFields | 'answers'>
  & Partial<Pick<AudiencePulseTheme, OptionalTopicTransitionFields>>
  & { answers?: AudiencePulseAnswerSummary }

type WireAudiencePulseReport =
  Omit<AudiencePulseHydratedReport, OptionalReportFields | 'themes'>
  & Partial<Pick<AudiencePulseHydratedReport, OptionalReportFields>>
  & { themes: WireAudiencePulseTheme[] }

type WireAudiencePulseReadResponse =
  | Exclude<AudiencePulseReadResponse, { kind: 'completed' }>
  | { kind: 'completed'; report: WireAudiencePulseReport }

type WireAudiencePulseRefreshResponse =
  | Exclude<AudiencePulseRefreshResponse, { kind: 'completed' }>
  | { kind: 'completed'; report: WireAudiencePulseReport }

/**
 * Restores today's report shape from an older response. Defaults state only what the
 * older API could already prove — no prior identity, no reused narrative, nothing
 * dissolved, no answer summary — so a version-skewed deploy renders a smaller report
 * instead of failing.
 */
function normalizeAudiencePulseReport(
  report: WireAudiencePulseReport,
): AudiencePulseHydratedReport {
  return {
    ...report,
    isFirstCensus: report.isFirstCensus ?? false,
    narrativeGeneratedAt: report.narrativeGeneratedAt ?? report.generatedAt,
    narrativeReuseCount: report.narrativeReuseCount ?? 0,
    dissolvedTopics: report.dissolvedTopics ?? [],
    themes: report.themes.map((theme) => ({
      ...theme,
      previousMemberCount: theme.previousMemberCount ?? null,
      previousShare: theme.previousShare ?? null,
      transition: theme.transition ?? null,
      answers: theme.answers ?? null,
    })),
  }
}

const BASE_PATH = '/quality/audience-pulse'

export const audiencePulseApi = {
  async read(options: { signal?: AbortSignal } = {}): Promise<AudiencePulseReadResponse> {
    const response = await request<WireAudiencePulseReadResponse>(
      BASE_PATH,
      { method: 'GET', signal: options.signal },
      { withSession: true },
    )
    return response.kind === 'completed'
      ? { kind: 'completed', report: normalizeAudiencePulseReport(response.report) }
      : response
  },

  async refresh(options: { signal?: AbortSignal } = {}): Promise<AudiencePulseRefreshResponse> {
    const response = await request<WireAudiencePulseRefreshResponse>(
      BASE_PATH,
      { method: 'POST', signal: options.signal },
      { withSession: true },
    )
    return response.kind === 'completed'
      ? { kind: 'completed', report: normalizeAudiencePulseReport(response.report) }
      : response
  },

  async getRefreshStatus(options: { signal?: AbortSignal } = {}): Promise<{ pending: boolean }> {
    return request<{ pending: boolean }>(
      `${BASE_PATH}/refresh-status`,
      { method: 'GET', signal: options.signal },
      { withSession: true },
    )
  },

  /** Marks a topic "not for us", which takes it out of the content queue and changes no count. */
  async dismissTopic(topicId: string): Promise<void> {
    await request<void>(
      `${BASE_PATH}/topics/${encodeURIComponent(topicId)}/dismissal`,
      { method: 'PUT' },
      { withSession: true },
    )
  },

  async restoreTopic(topicId: string): Promise<void> {
    await request<void>(
      `${BASE_PATH}/topics/${encodeURIComponent(topicId)}/dismissal`,
      { method: 'DELETE' },
      { withSession: true },
    )
  },

  /** Records a document drafted from a topic; the link goes when the document does. */
  async linkTopicDraft(input: { topicId: string; documentId: string }): Promise<void> {
    await request<void>(
      `${BASE_PATH}/topics/${encodeURIComponent(input.topicId)}/drafts`,
      { method: 'POST', body: JSON.stringify({ documentId: input.documentId }) },
      { withSession: true },
    )
  },

  async getEvidenceAnchor(input: {
    conversationId: string
    messageId: string
    signal?: AbortSignal
  }): Promise<AudiencePulseEvidenceAnchorResponse> {
    return request<AudiencePulseEvidenceAnchorResponse>(
      `${BASE_PATH}/evidence-anchor`,
      {
        method: 'POST',
        signal: input.signal,
        body: JSON.stringify({
          conversationId: input.conversationId,
          messageId: input.messageId,
        }),
      },
      { withSession: true },
    )
  },
}

export function getAudiencePulseErrorCode(error: unknown): string | undefined {
  if (
    error
    && typeof error === 'object'
    && 'error' in error
    && (error as ErrorResponse).error
    && typeof (error as ErrorResponse).error.code === 'string'
  ) {
    return (error as ErrorResponse).error.code
  }
  return undefined
}
