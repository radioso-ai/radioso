import type { FeedbackValue, QualityActionFilter, QualityTriageState } from '@/lib/api'
import type { SkillCatalogEntry } from '@/lib/api'
import type { QualityLatencyFilter, QualityStatusFilter } from '@/lib/dashboard-routes'

/**
 * Triage states still in the active backlog. The signal tiles count only these
 * so resolved/dismissed turns drain out of the totals.
 */
export const ACTIVE_TRIAGE_STATES: readonly QualityTriageState[] = ['open', 'acknowledged']

/**
 * Operator triage signals surfaced above the assistant-answers table. Each one
 * maps to a preset over the existing server-side filters so a single click
 * narrows the table to that class of issue.
 */
export type QualitySignalId =
  | 'negative_feedback'
  | 'grounding_gaps'
  | 'slow_responses'
  | 'skill_failures'

/** Latency band used by the "slow responses" signal (10 seconds or more). */
export const SLOW_RESPONSE_LATENCY_BUCKET: QualityLatencyFilter = 'gte_10s'

/**
 * Skill-status preset for the "skill failures" signal. Any turn whose dispatched
 * skill ended in `failed` — capability-agnostic, so it surfaces failures from the
 * whole engine surface, not just retrieval. Reuses the persisted `skill_status`,
 * so no spine query is needed.
 */
export const SKILL_FAILURE_STATUSES: readonly QualityStatusFilter[] = ['failed']

/**
 * Grounding-gap outcomes are the ones the skill catalog marks as not producing
 * a grounded answer (`groundedAnswer === false`) — e.g. "no context" or
 * degraded retrieval. Derived from structured catalog metadata, never from
 * outcome-name matching, so it stays correct as skills evolve and across
 * locales.
 */
export function groundingGapActions(
  skills: SkillCatalogEntry[],
): QualityActionFilter[] {
  const actions: QualityActionFilter[] = []
  for (const skill of skills) {
    for (const outcome of skill.outcomes ?? []) {
      if (outcome.groundedAnswer === false) {
        actions.push({ skillName: skill.name, outcome: outcome.name })
      }
    }
  }
  return actions
}

export interface AppliedQualityFilters {
  feedback: FeedbackValue[]
  actions: QualityActionFilter[]
  statuses: QualityStatusFilter[]
  triageStates: QualityTriageState[]
  latency: QualityLatencyFilter | null
}

const actionKey = (action: QualityActionFilter): string =>
  `${action.skillName}:${action.outcome}`

const sameActionSet = (
  left: QualityActionFilter[],
  right: QualityActionFilter[],
): boolean => {
  if (left.length !== right.length) {
    return false
  }
  const rightKeys = new Set(right.map(actionKey))
  return left.every((action) => rightKeys.has(actionKey(action)))
}

const sameStringSet = (
  left: readonly string[],
  right: readonly string[],
): boolean => {
  if (left.length !== right.length) {
    return false
  }
  const rightValues = new Set(right)
  return left.every((value) => rightValues.has(value))
}

const hasActiveTriagePreset = (triageStates: QualityTriageState[]): boolean =>
  sameStringSet(triageStates, ACTIVE_TRIAGE_STATES)

/**
 * Which operator signal, if any, the currently applied filters represent. Used
 * to toggle the signal tiles' active state. Returns null when the filters do
 * not correspond to exactly one signal preset (e.g. a manual combination from
 * the filter dialog), so manual filtering never lights up a tile.
 */
export function activeQualitySignal(
  applied: AppliedQualityFilters,
  groundingActions: QualityActionFilter[],
): QualitySignalId | null {
  const hasFeedback = applied.feedback.length > 0
  const hasActions = applied.actions.length > 0
  const hasStatuses = applied.statuses.length > 0
  const hasLatency = applied.latency != null
  const hasActiveTriage = hasActiveTriagePreset(applied.triageStates)

  if (
    hasActiveTriage &&
    hasFeedback &&
    !hasActions &&
    !hasStatuses &&
    !hasLatency &&
    applied.feedback.length === 1 &&
    applied.feedback[0] === 'down'
  ) {
    return 'negative_feedback'
  }

  if (
    hasActiveTriage &&
    hasLatency &&
    !hasFeedback &&
    !hasActions &&
    !hasStatuses &&
    applied.latency === SLOW_RESPONSE_LATENCY_BUCKET
  ) {
    return 'slow_responses'
  }

  if (
    hasActiveTriage &&
    hasActions &&
    !hasFeedback &&
    !hasStatuses &&
    !hasLatency &&
    groundingActions.length > 0 &&
    sameActionSet(applied.actions, groundingActions)
  ) {
    return 'grounding_gaps'
  }

  if (
    hasActiveTriage &&
    hasStatuses &&
    !hasFeedback &&
    !hasActions &&
    !hasLatency &&
    sameStringSet(applied.statuses, SKILL_FAILURE_STATUSES)
  ) {
    return 'skill_failures'
  }

  return null
}
