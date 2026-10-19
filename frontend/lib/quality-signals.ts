import { QUALITY_SIGNAL_IDS, type QualitySignalId, type QualityTriageState } from '@/lib/api'

/**
 * Triage states still in the active backlog. The signal chips and the inbox count
 * only these so resolved/dismissed turns drain out of the totals.
 *
 * Signal classification itself lives in the backend quality module and is
 * addressed by `QualitySignalId` — one definition shared by the health rates and
 * the chip counts, rather than reconstructed here from the skill catalog.
 */
export const ACTIVE_TRIAGE_STATES: readonly QualityTriageState[] = ['open', 'acknowledged']

/**
 * Signals an operator asks for by its chip or filter, kept out of the default queue and the
 * Inbox count. `unmet_directives` is the answer's own grade of itself (#1575), so it stays
 * opt-in until the directive-adherence verdict counter shows how often turns grade
 * themselves unsatisfied.
 */
const OPT_IN_QUALITY_SIGNAL_IDS: ReadonlySet<QualitySignalId> = new Set(['unmet_directives'])

/** The signals the review queue and the Inbox count ask for when no chip is selected. */
export const DEFAULT_QUALITY_SIGNAL_IDS: readonly QualitySignalId[] = QUALITY_SIGNAL_IDS.filter(
  (id) => !OPT_IN_QUALITY_SIGNAL_IDS.has(id),
)

export const isTerminalQualityTriageState = (state: QualityTriageState): boolean =>
  state === 'resolved' || state === 'dismissed'

interface QueueScopeInput {
  /** The operator asked for every answer, signal or not. */
  showAll: boolean
  /** The chip currently selected, if any. */
  signal: QualitySignalId | null
  /** Triage states the operator set explicitly in the filter dialog. */
  triageStates: readonly QualityTriageState[]
}

interface QueueScope {
  signals?: QualitySignalId[]
  triageStates?: QualityTriageState[]
}

/**
 * What the queue asks the server for.
 *
 * The queue is a triage queue, so by default it asks for the population the chips count:
 * answers carrying any default quality signal, still in an active triage state. Without that
 * default the table returns every assistant turn, and the chip counts describe nothing
 * the operator can see in it.
 *
 * A chip narrows the union to one signal. "All answers" drops both defaults — and only
 * the defaults: filters the operator set explicitly always survive, and an explicit
 * triage choice outranks the active-backlog default rather than being merged with it.
 */
export const resolveQueueScope = ({ showAll, signal, triageStates }: QueueScopeInput): QueueScope => {
  const explicitTriage = triageStates.length > 0 ? [...triageStates] : undefined

  if (showAll) {
    return { triageStates: explicitTriage }
  }

  return {
    signals: signal ? [signal] : [...DEFAULT_QUALITY_SIGNAL_IDS],
    triageStates: explicitTriage ?? [...ACTIVE_TRIAGE_STATES],
  }
}
