import { answerStatusLabel, type AnswerStatus } from '@/lib/answer-coverage'
import type { AudiencePulseAnswerSummary } from '@/lib/api-audience-pulse'

const SUMMARY_KEY: Record<AnswerStatus, keyof AudiencePulseAnswerSummary> = {
  answered: 'answered',
  partial: 'partial',
  unanswered: 'unanswered',
  unclear: 'unclear',
  out_of_scope: 'outOfScope',
  not_assessed: 'notAssessed',
}

const COUNTS_ORDER: readonly AnswerStatus[] = [
  'answered',
  'unanswered',
  'partial',
  'unclear',
  'out_of_scope',
  'not_assessed',
]

// The buckets a collapsed topic row surfaces, in the counts line's order.
const SHORTFALL_ORDER: readonly AnswerStatus[] = ['unanswered', 'partial']

const numberFormat = new Intl.NumberFormat()

const formatBuckets = (answers: AudiencePulseAnswerSummary, order: readonly AnswerStatus[]): string[] =>
  order
    .filter((status) => answers[SUMMARY_KEY[status]] > 0)
    .map((status) => `${numberFormat.format(answers[SUMMARY_KEY[status]])} ${answerStatusLabel(status).toLowerCase()}`)

/** A topic's answer counts as one line, e.g. "6 answered · 1 partly answered · 2 not assessed". */
export function formatTopicAnswerCounts(answers: AudiencePulseAnswerSummary): string {
  return formatBuckets(answers, COUNTS_ORDER).join(' · ')
}

/**
 * The buckets where the agent fell short, e.g. ["2 unanswered", "1 partly answered"],
 * worded exactly as they appear in the expanded counts line.
 */
export function getTopicShortfalls(answers: AudiencePulseAnswerSummary): string[] {
  return formatBuckets(answers, SHORTFALL_ORDER)
}
