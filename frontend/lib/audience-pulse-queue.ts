import type {
  AudiencePulseContentGap,
  AudiencePulseHydratedReport,
  AudiencePulseRecommendation,
  AudiencePulseTheme,
} from '@/lib/api-audience-pulse'
import type { AudiencePulseDraftSeed } from '@/lib/audience-pulse-draft-seed'
import { questionLabel } from '@/lib/visitor-image-input'

/** A topic the operator marked "not for us" (true) or brought back (false) since the report was read. */
export type DismissalChoices = Readonly<Record<string, boolean>>

export interface ContentQueueItem {
  topicId: string
  /** The recommendation's title, else the topic's. */
  title: string
  topicTitle: string
  /** Questions with no answer in your content. */
  noAnswerCount: number
  conversationCount: number
  rationale: string | null
  questions: string[]
  latestDraft: { documentId: string; createdAt: string } | null
  draftSeed: AudiencePulseDraftSeed
}

export interface ContentQueue {
  items: ContentQueueItem[]
  /** Questions with no answer in your content across the queue. */
  noAnswerCount: number
  dismissedTopicIds: string[]
}

const isDismissed = (gap: AudiencePulseContentGap, choices: DismissalChoices): boolean =>
  choices[gap.themeId] ?? Boolean(gap.dismissedAt)

/** The topic's questions where the documents fell short: no answer or only part of one. */
const gapQuestions = (theme: AudiencePulseTheme): string[] => [
  ...new Set(
    theme.evidence
      .filter((evidence) => evidence.answerStatus === 'unanswered' || evidence.answerStatus === 'partial')
      .map((evidence) => questionLabel(evidence))
      .filter((question) => question.trim().length > 0),
  ),
]

const queueItem = (
  gap: AudiencePulseContentGap,
  theme: AudiencePulseTheme,
  recommendation: AudiencePulseRecommendation | undefined,
): ContentQueueItem => {
  const questions = recommendation && recommendation.questions.length > 0 ? recommendation.questions : gapQuestions(theme)
  return {
    topicId: theme.id,
    title: recommendation?.title ?? theme.title,
    topicTitle: theme.title,
    noAnswerCount: gap.eligibleEvidenceCount,
    conversationCount: gap.distinctConversationCount,
    rationale: recommendation?.rationale ?? null,
    questions,
    latestDraft: gap.latestDraft ?? null,
    draftSeed: recommendation
      ? { title: recommendation.startDraft.title, questions: recommendation.startDraft.questions, topicId: theme.id }
      : { title: theme.title, questions, topicId: theme.id },
  }
}

/**
 * "Content to write": the report's content gaps the operator has not marked "not for us", the
 * topic with the most questions that had no answer in your content first.
 */
export const contentQueue = (
  report: AudiencePulseHydratedReport,
  choices: DismissalChoices,
): ContentQueue => {
  const themes = new Map(report.themes.map((theme) => [theme.id, theme]))
  const recommendations = new Map<string, AudiencePulseRecommendation>()
  for (const recommendation of report.recommendations) {
    if (!recommendations.has(recommendation.themeId)) recommendations.set(recommendation.themeId, recommendation)
  }

  const items: ContentQueueItem[] = []
  const dismissedTopicIds: string[] = []
  for (const gap of report.contentGaps) {
    const theme = themes.get(gap.themeId)
    if (!theme) continue
    if (isDismissed(gap, choices)) {
      dismissedTopicIds.push(gap.themeId)
      continue
    }
    items.push(queueItem(gap, theme, recommendations.get(gap.themeId)))
  }
  items.sort((left, right) =>
    right.noAnswerCount - left.noAnswerCount || right.conversationCount - left.conversationCount)

  return {
    items,
    noAnswerCount: items.reduce((sum, item) => sum + item.noAnswerCount, 0),
    dismissedTopicIds,
  }
}
