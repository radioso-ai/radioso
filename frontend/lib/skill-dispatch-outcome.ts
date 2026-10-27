/**
 * Operator-facing words for how a skill call ended, shared by the routine step view and the
 * conversation spine's skill dispatch stage, so one reason reads the same in both.
 */

const spaced = (value: string): string => value.replaceAll('_', ' ')

const notCalledReason = (reason: string): string | undefined => {
  switch (reason) {
    case 'suppressed_for_safe_test':
      return 'not called (skills are off in this test)'
    case 'requires_durable_conversation':
      return 'not called (needs a saved conversation; runs after publish)'
    default:
      return undefined
  }
}

/** A skill's status and failure reason, as a short phrase; undefined when neither is known. */
export const skillOutcomeLabel = ({ status, reason }: { status?: string; reason?: string }): string | undefined => {
  if (reason) {
    return notCalledReason(reason) ?? (status ? `${spaced(status)} (${spaced(reason)})` : spaced(reason))
  }
  return status ? spaced(status) : undefined
}

interface SkillDispatchOutcomeView {
  /** How the dispatch ended, with the reason when the skill did not answer. */
  outcome?: string
  /** Set on a fallback dispatch: the skill it answered in place of. */
  fallbackNote?: string
}

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined

/** Reads a `skill_dispatch` stage's outputs (`outcomeStatus`, `failureReason`, `fallbackFor`). */
export const skillDispatchOutcome = (outputs: Record<string, unknown> | undefined): SkillDispatchOutcomeView => {
  const outcome = skillOutcomeLabel({ status: asString(outputs?.outcomeStatus), reason: asString(outputs?.failureReason) })
  const fallbackFor = asString(outputs?.fallbackFor)
  return {
    ...(outcome ? { outcome } : {}),
    ...(fallbackFor ? { fallbackNote: `in place of ${fallbackFor}` } : {}),
  }
}
