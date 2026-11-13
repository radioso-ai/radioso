import type { RoutineStepSelectionOutcome, RoutineTraceStepView } from '@/lib/routine-run-trace'

/**
 * How the turn inspector names each step event of a routine's trace, in plain language, so the
 * timeline reads without knowing the engine's terms.
 */

const ROUTINE_EVENT_LABELS: Record<string, string> = {
  resumed: 'Resumed',
  advanced: 'Advanced',
  reasked: 'Re-asked',
  fast_forwarded: 'Skipped',
  skill_dispatched: 'Tool ran',
  action_emitted: 'Action sent',
  rendered: 'Replied here',
  reask_limit_reached: 'Re-ask limit',
  reask_limit_handoff: 'Stuck, handed off',
  consent_asked: 'Asked consent',
  consent_decided: 'Consent answered',
  consent_reused: 'Consent on file',
  consent_skipped: 'Consent not asked',
  item_selected: 'Card picked',
}

const ROUTINE_EVENT_DESCRIPTIONS: Record<string, string> = {
  resumed: 'Where the routine picked up this turn.',
  advanced: 'The step was satisfied, so the routine moved on.',
  reasked: 'The routine stayed on this step and asked again.',
  fast_forwarded: 'Skipped without asking — it already had what this step asks for.',
  skill_dispatched: 'Ran this step’s tool.',
  action_emitted: 'Emitted a fire-and-forget action.',
  rendered: 'The reply you saw was generated from this step.',
  reask_limit_reached: 'Asked too many times in a row, so the reply asked differently.',
  reask_limit_handoff: 'Still unanswered after asking differently, so the routine ended and a person takes over.',
  item_selected: 'The visitor picked one of the cards this step showed, which filled its item field.',
}

const CONSENT_SKIP_DESCRIPTIONS: Record<string, string> = {
  channel: 'This channel asks no consent, so the routine took the consent’s decline path.',
  wording_unavailable: 'No wording could be shown, or the reply could not be matched to the wording shown, so the routine took the consent’s decline path.',
  no_port: 'This runtime cannot ask consent, so the routine took the consent’s decline path.',
}

/** What a consent step did this turn (#1544), from its keys-only detail on the trace. */
const consentEventDescription = (step: RoutineTraceStepView): string | undefined => {
  const consent = step.consent
  switch (step.event) {
    case 'consent_asked':
      return consent?.reask
        ? 'The reply was unclear, so the wording was shown again after a short answer.'
        : 'Showed the consent wording; the routine waits for the visitor’s answer.'
    case 'consent_decided':
      if (consent?.defaulted) return 'Still unclear after asking twice, so it counted as a decline.'
      return consent?.decision === 'granted'
        ? 'The visitor agreed, so the routine moved on to collect the field.'
        : 'The visitor declined, so the routine took the consent’s decline path.'
    case 'consent_reused':
      return consent?.decision === 'granted'
        ? 'Agreed earlier in this conversation, so not asked again.'
        : 'Declined earlier in this conversation, so the routine took the decline path.'
    case 'consent_skipped':
      return CONSENT_SKIP_DESCRIPTIONS[consent?.reason ?? ''] ?? 'Not asked, so the routine took the consent’s decline path.'
    default:
      return undefined
  }
}

export const routineEventLabel = (step: Pick<RoutineTraceStepView, 'event'>): string =>
  ROUTINE_EVENT_LABELS[step.event] ?? step.event

// A step the first turn read the opening message for (#1370), flagged explicitly rather
// than inferred from captured keys (a step can read the message and still come up empty).
// It either moved on, or is rendered as a first ask — the value it did read is filled into
// its own instruction, not repeated in this line. What it moved on with can also come from
// an earlier run of a re-entered routine, so that line does not credit the message.
export const routineEventDescription = (step: RoutineTraceStepView): string | undefined => {
  if (step.readOpeningMessage) {
    return step.event === 'rendered'
      ? 'Read the opening message first; it did not give everything this step asks for.'
      : 'Read the opening message first, then moved on without asking.'
  }
  return ROUTINE_EVENT_DESCRIPTIONS[step.event] ?? consentEventDescription(step)
}

const ROUTINE_SELECTION_OUTCOME_LABELS: Record<RoutineStepSelectionOutcome, string> = {
  transition: 'Chose an exit',
  stay: 'Stayed on step',
  off_topic: 'Read as off-topic',
  unreadable: 'Unreadable model output',
  authority_claim: 'Held: posed as a system notice',
}

export const routineSelectionOutcomeLabel = (outcome: RoutineStepSelectionOutcome): string =>
  ROUTINE_SELECTION_OUTCOME_LABELS[outcome]

const ROUTINE_EVENT_TONE: Record<string, string> = {
  advanced: 'bg-emerald-500/10 text-emerald-600',
  reasked: 'bg-amber-500/10 text-amber-600',
  fast_forwarded: 'bg-sky-500/10 text-sky-600',
  skill_dispatched: 'bg-primary/10 text-primary',
  action_emitted: 'bg-primary/10 text-primary',
  rendered: 'bg-muted text-muted-foreground',
  reask_limit_reached: 'bg-amber-500/10 text-amber-600',
  reask_limit_handoff: 'bg-amber-500/10 text-amber-600',
  consent_asked: 'bg-sky-500/10 text-sky-600',
  consent_decided: 'bg-emerald-500/10 text-emerald-600',
  consent_reused: 'bg-muted text-muted-foreground',
  consent_skipped: 'bg-amber-500/10 text-amber-600',
  item_selected: 'bg-emerald-500/10 text-emerald-600',
}

export const routineEventTone = (step: Pick<RoutineTraceStepView, 'event'>): string =>
  ROUTINE_EVENT_TONE[step.event] ?? 'bg-muted text-muted-foreground'
