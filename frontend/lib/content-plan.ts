import type {
  ContentPlanPage,
  ContentPlanEnrichmentState,
  ContentPlanEvidenceStrength,
  ContentPlanHeadlineState,
  ContentPlanPriorityReason,
  ContentPlanProjectionState,
  ContentPlanRecommendation,
  ContentPlanRecommendationAction,
  ContentPlanTrend,
} from './api-content-plan'

/** A copy action is useful only when the generated brief is actually present. */
export const hasCopyableContentPlanBrief = (
  recommendation: ContentPlanRecommendation,
): boolean => Boolean(
  recommendation.rationale
  && recommendation.suggestedTitle
  && recommendation.questionsToAnswer.length > 0
  && recommendation.suggestedShape
  && recommendation.evidenceStatement,
)

/**
 * Append a cursor page without replacing the report snapshot established by
 * the first page. Topic ids are canonical and therefore form the stable
 * deduplication key when adjacent pages overlap during a near-current update.
 */
export const mergeContentPlanPage = (
  firstPage: ContentPlanPage,
  nextPage: ContentPlanPage,
): ContentPlanPage => {
  const seenTopicIds = new Set(firstPage.items.map((topic) => topic.id))
  const uniqueTopics = nextPage.items.filter((topic) => {
    if (seenTopicIds.has(topic.id)) {
      return false
    }
    seenTopicIds.add(topic.id)
    return true
  })

  return {
    ...firstPage,
    items: [...firstPage.items, ...uniqueTopics],
    nextCursor: nextPage.nextCursor,
  }
}

/**
 * Presentation-only helpers for Content plan. Ordering, action selection, rates,
 * trend classification, and evidence-strength banding are backend-owned; this
 * file only maps typed contract values to English labels/tones for the UI.
 */

export const projectionStateLabel = (state: ContentPlanProjectionState): string => {
  switch (state) {
    case 'bootstrapping':
      return 'Bootstrapping'
    case 'ready':
      return 'Up to date'
    case 'updating':
      return 'Updating'
    case 'delayed':
      return 'Delayed'
    case 'reprojecting':
      return 'Reprojecting'
    case 'degraded':
      return 'Degraded'
    case 'budget_paused':
      return 'Paused (budget)'
  }
}

export const projectionStateExplanation = (state: ContentPlanProjectionState): string => {
  switch (state) {
    case 'bootstrapping':
      return 'Building the first coherent view from the last 60 days of eligible traffic.'
    case 'ready':
      return 'All eligible turns are reflected in the current view.'
    case 'updating':
      return 'New eligible turns are being incorporated.'
    case 'delayed':
      return 'Processing is behind the newest turns.'
    case 'reprojecting':
      return 'Rebuilding the projection after an embedding-space change.'
    case 'degraded':
      return 'Some enrichment is unavailable. Evidence and demand still reconcile.'
    case 'budget_paused':
      return 'Per-workspace fallback budget was reached. Progress will resume after the window resets.'
  }
}

export const isProjectionQuietOk = (state: ContentPlanProjectionState): boolean =>
  state === 'ready'

export const trendLabel = (trend: ContentPlanTrend): string => {
  switch (trend) {
    case 'new':
      return 'New'
    case 'rising':
      return 'Rising'
    case 'steady':
      return 'Steady'
    case 'falling':
      return 'Falling'
    case 'insufficient_data':
      return 'Too few in the previous window'
  }
}

export const evidenceStrengthLabel = (strength: ContentPlanEvidenceStrength): string => {
  switch (strength) {
    case 'none':
      return 'No measured evidence'
    case 'low':
      return 'Low evidence'
    case 'medium':
      return 'Medium evidence'
    case 'high':
      return 'High evidence'
  }
}

export const evidenceSampleSentence = (
  evaluatedConversationCount: number,
  strength: ContentPlanEvidenceStrength,
): string => {
  if (evaluatedConversationCount === 0) {
    return 'Based on 0 conversations with grounding measured.'
  }
  const conversationCopy = evaluatedConversationCount === 1 ? 'conversation' : 'conversations'
  return `Based on ${evaluatedConversationCount} ${conversationCopy} with grounding measured — ${evidenceStrengthLabel(strength).toLowerCase()}.`
}

export const enrichmentStateLabel = (state: ContentPlanEnrichmentState): string => {
  switch (state) {
    case 'pending':
      return 'Preparing'
    case 'ready':
      return 'Ready'
    case 'stale':
      return 'Being refreshed'
    case 'unavailable':
      return 'Unavailable'
    case 'outside_analysis_cap':
      return 'Outside the analysis cap'
  }
}

export const priorityReasonLabel = (reason: ContentPlanPriorityReason): string => {
  switch (reason) {
    case 'active_no_support':
      return 'Active no-support answers'
    case 'active_degraded':
      return 'Active degraded answers'
    case 'high_demand':
      return 'High demand'
    case 'new_demand':
      return 'New demand'
    case 'rising_demand':
      return 'Rising demand'
  }
}

export const recommendationActionLabel = (
  action: ContentPlanRecommendationAction | null,
): string => {
  switch (action) {
    case 'add_content':
      return 'Add content'
    case 'review_existing_content':
      return 'Review existing content'
    case 'investigate_retrieval':
      return 'Investigate retrieval'
    case 'monitor':
      return 'Monitor'
    case null:
      return 'No recommendation yet'
  }
}

export const recommendationActionExplanation = (
  action: ContentPlanRecommendationAction | null,
): string => {
  switch (action) {
    case 'add_content':
      return 'No related workspace document was found. Draft new content that answers the visitor questions below.'
    case 'review_existing_content':
      return 'Related content exists. Review it, verify it answers the questions, and re-test.'
    case 'investigate_retrieval':
      return 'Relevant content existed but the failing answers generally missed it. Look at retrieval before creating a duplicate.'
    case 'monitor':
      return 'Coverage looks acceptable. Keep watching demand and grounding evidence.'
    case null:
      return 'Corpus evidence or enrichment is not yet available. Actions will appear when the analysis catches up.'
  }
}

export const headlineStateAnnotation = (state: ContentPlanHeadlineState): string => {
  switch (state) {
    case 'measured':
      return 'Measured'
    case 'insufficient_measured_turns':
      return 'Too few measured answers for a percentage'
    case 'unmeasured':
      return 'Unmeasured — no grounding-evaluated answers'
  }
}

const rateFormatter = new Intl.NumberFormat(undefined, {
  style: 'percent',
  maximumFractionDigits: 0,
})

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
})

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
})

/** Format a rate as a percentage. Returns null when the rate isn't measured. */
export const formatRatePercent = (rate: number | null): string | null =>
  rate === null ? null : rateFormatter.format(rate)

/** Format an ISO instant as "Aug 2, 2026, 12:00 PM". Falls back to the raw string. */
export const formatAsOfTimestamp = (iso: string): string => {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : dateTimeFormatter.format(date)
}

export const formatWindowRange = (from: string, to: string): string => {
  const fromDate = new Date(from)
  const toDate = new Date(to)
  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
    return `${from} – ${to}`
  }
  return `${dateFormatter.format(fromDate)} – ${dateFormatter.format(toDate)}`
}

const relativeTimeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

/** Rounded lag summary: "2 minutes ago". Returns "just now" for < 60s. */
export const formatProcessingLag = (lagSeconds: number | null): string => {
  if (lagSeconds === null || !Number.isFinite(lagSeconds) || lagSeconds < 0) {
    return 'Processing status unknown'
  }
  if (lagSeconds < 60) {
    return 'Updated just now'
  }
  const minutes = Math.round(lagSeconds / 60)
  if (minutes < 60) {
    return `Updated ${relativeTimeFormatter.format(-minutes, 'minute')}`
  }
  const hours = Math.round(minutes / 60)
  return `Updated ${relativeTimeFormatter.format(-hours, 'hour')}`
}

/**
 * The prose outline handed to the inline document draft. Only questions from the
 * server-owned brief become bullet points; no visitor question text, prompt
 * output, or factual claim is fabricated on the client.
 */
export const buildDraftDocumentContent = (
  questionsToAnswer: readonly string[],
): string => {
  if (questionsToAnswer.length === 0) {
    return ['## Questions to answer', '- (Add the questions this content should answer.)'].join('\n')
  }
  const bullets = questionsToAnswer.map((question) => `- ${question}`)
  return ['## Questions to answer', ...bullets, '', 'Verify every fact against a workspace-approved source before publishing.'].join('\n')
}
