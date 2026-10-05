import {
  ANSWER_COVERAGE_OUT_OF_SCOPE_LABEL,
  answerCoverageLabel,
  isScopeBoundaryDecline,
  type AnswerCoverageValue,
} from '@/lib/answer-coverage'
import type {
  AudiencePulseCoverageSummary,
  AudiencePulseTheme,
  AudiencePulseThemeEvidence,
} from '@/lib/api-audience-pulse'

/**
 * How the agent handled a visitor's question, in the turn inspector's words.
 * A scope-boundary decline reads as "Out of scope", and a question with no
 * recorded verdict as "Not assessed".
 */
type AnswerBucket = AnswerCoverageValue | 'out_of_scope' | 'not_assessed'

const COUNTS_ORDER: readonly AnswerBucket[] = [
  'answered',
  'partial',
  'unanswered',
  'unclear',
  'out_of_scope',
  'not_assessed',
]

// The buckets a collapsed topic row surfaces, worst first.
const SHORTFALL_ORDER: readonly AnswerBucket[] = ['unanswered', 'partial']

// Examples where the agent fell short lead the list; everything else keeps report order.
const SHORTFALL_RANK: Partial<Record<AnswerBucket, number>> = { unanswered: 0, partial: 1 }
const OTHER_RANK = 2

const numberFormat = new Intl.NumberFormat()

const bucketLabel = (bucket: AnswerBucket): string => {
  if (bucket === 'out_of_scope') return ANSWER_COVERAGE_OUT_OF_SCOPE_LABEL
  return answerCoverageLabel(bucket === 'not_assessed' ? undefined : bucket)
}

/** The report's semantic answer checks for a topic; null when the saved report carries none. */
const answerChecks = (theme: Pick<AudiencePulseTheme, 'coverage'>): AudiencePulseCoverageSummary | null =>
  theme.coverage ?? null

const countByBucket = (theme: Pick<AudiencePulseTheme, 'coverage' | 'grounding'>): Record<AnswerBucket, number> => {
  const coverage = answerChecks(theme)
  if (coverage) {
    return {
      answered: coverage.answered,
      partial: coverage.partial,
      unanswered: coverage.unanswered,
      unclear: coverage.unclear,
      out_of_scope: coverage.outOfScope,
      not_assessed: coverage.unassessed + coverage.legacy,
    }
  }
  // Reports saved before answers were checked carry only the grounding verdicts.
  const { grounding } = theme
  return {
    answered: grounding.grounded,
    partial: grounding.degraded,
    unanswered: grounding.noSupport,
    unclear: 0,
    out_of_scope: 0,
    not_assessed: grounding.unknown,
  }
}

const formatBuckets = (
  theme: Pick<AudiencePulseTheme, 'coverage' | 'grounding'>,
  order: readonly AnswerBucket[],
): string[] => {
  const counts = countByBucket(theme)
  return order
    .filter((bucket) => counts[bucket] > 0)
    .map((bucket) => `${numberFormat.format(counts[bucket])} ${bucketLabel(bucket).toLowerCase()}`)
}

/** A topic's answer counts as one line, e.g. "6 answered · 1 partly answered · 2 not assessed". */
export function formatTopicAnswerCounts(theme: Pick<AudiencePulseTheme, 'coverage' | 'grounding'>): string {
  return formatBuckets(theme, COUNTS_ORDER).join(' · ')
}

/**
 * The buckets where the agent fell short, e.g. ["2 unanswered", "1 partly answered"],
 * worded exactly as they appear in the expanded counts line.
 */
export function getTopicShortfalls(theme: Pick<AudiencePulseTheme, 'coverage' | 'grounding'>): string[] {
  return formatBuckets(theme, SHORTFALL_ORDER)
}

interface TopicExample {
  evidence: AudiencePulseThemeEvidence
  /** Null when the report predates answer checks: no example carries a verdict of its own. */
  label: string | null
}

const exampleBucket = (evidence: AudiencePulseThemeEvidence): AnswerBucket => {
  const assessment = evidence.answerCoverage
  if (assessment?.availability !== 'assessed' || !assessment.coverage) return 'not_assessed'
  return isScopeBoundaryDecline(assessment.coverage, assessment.reason) ? 'out_of_scope' : assessment.coverage
}

/** A topic's example questions, each labelled with how it was answered, shortfalls first. */
export function getTopicExamples(theme: Pick<AudiencePulseTheme, 'coverage' | 'evidence'>): TopicExample[] {
  const reportChecksAnswers = answerChecks(theme) !== null
  return theme.evidence
    .map((evidence) => ({ evidence, bucket: exampleBucket(evidence) }))
    .sort((left, right) => rank(left.bucket) - rank(right.bucket))
    .map(({ evidence, bucket }) => ({ evidence, label: reportChecksAnswers ? bucketLabel(bucket) : null }))
}

const rank = (bucket: AnswerBucket): number => SHORTFALL_RANK[bucket] ?? OTHER_RANK
