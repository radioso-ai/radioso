import type { ConversationTraceStage } from '@/lib/api'
import { skillOutcomeLabel } from '@/lib/skill-dispatch-outcome'

/**
 * Reads a routine stage's `routine` sub-trace into the step-by-step view the turn inspector
 * renders. Slot keys only: the runner never puts a captured value on this trace, and the
 * reader ignores anything else on the payload.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined

const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

const asStringArray = (value: unknown): string[] =>
  asArray(value).filter((entry): entry is string => typeof entry === 'string')

const ROUTINE_SELECTION_OUTCOMES = ['transition', 'stay', 'off_topic', 'unreadable', 'authority_claim'] as const
export type RoutineStepSelectionOutcome = (typeof ROUTINE_SELECTION_OUTCOMES)[number]

const asRoutineSelectionOutcome = (value: unknown): RoutineStepSelectionOutcome | undefined =>
  typeof value === 'string' &&
  (ROUTINE_SELECTION_OUTCOMES as readonly string[]).includes(value)
    ? (value as RoutineStepSelectionOutcome)
    : undefined

/**
 * The next-step selector's own reading of one step, so an operator can tell "the
 * model returned nothing" from "the model returned a value that was not captured"
 * (#1370). Slot keys and counts only, mirroring the wire shape's own privacy rule.
 */
interface RoutineStepSelectionView {
  outcome: RoutineStepSelectionOutcome
  returnedSlotKeys: string[]
  undeclaredKeyCount?: number
}

const buildRoutineStepSelection = (value: unknown): RoutineStepSelectionView | undefined => {
  if (!isRecord(value)) return undefined
  const outcome = asRoutineSelectionOutcome(value.outcome)
  if (!outcome) return undefined
  const undeclaredKeyCount = asNumber(value.undeclaredKeyCount)
  return {
    outcome,
    returnedSlotKeys: asStringArray(value.returnedSlotKeys),
    ...(typeof undeclaredKeyCount === 'number' && undeclaredKeyCount > 0 ? { undeclaredKeyCount } : {}),
  }
}

/** One step's outcome as the runner walked the routine graph this turn. */
export interface RoutineTraceStepView {
  stepId: string
  kind: string
  event: string
  capturedSlotKeys: string[]
  /** Slot keys that already held a value and were given a different one at this step. */
  replacedSlotKeys?: string[]
  viaSelector: boolean
  skillName?: string
  skillStatus?: string
  /** Failure reason for a failed tool step, e.g. `suppressed_for_safe_test`, `mcp_timeout`. */
  skillReason?: string
  /** How the tool call ended, in the words the skill dispatch stage uses too. */
  skillOutcome?: string
  /** The next-step selector's own reading of this turn, when a model call ran here. */
  selection?: RoutineStepSelectionView
  /** Slot keys whose returned value did not fit the slot's type and was not stored (#1374). */
  rejectedSlotKeys?: string[]
  /** On the routine's first turn, this step read the opening message before it was asked (#1370). */
  readOpeningMessage?: boolean
}

// Keys only: the runner never puts a rejected value on the trace, and this ignores one if present.
const rejectedSlotKeysOf = (value: unknown): string[] =>
  asArray(value).flatMap((entry) => {
    const key = isRecord(entry) ? asString(entry.key) : undefined
    return key ? [key] : []
  })

export interface RoutineRunTraceView {
  startStepId?: string
  landedStepId?: string
  terminalKind?: string
  capturedSlotKeys: string[]
  /** Slot keys that held a value before the turn and were given a different one. */
  replacedSlotKeys?: string[]
  filledSlotKeys: string[]
  /** The turn could not notify the team, so its reply was told not to claim the team was told. */
  operatorsUnreachable?: true
  steps: RoutineTraceStepView[]
}

/** The turn's walk as the stage detail lists it, each key present only when the trace carries it. */
export const routineRunFacts = (trace: RoutineRunTraceView | undefined): Record<string, string | boolean> => ({
  ...(trace?.startStepId ? { startStep: trace.startStepId } : {}),
  ...(trace?.landedStepId ? { landedStep: trace.landedStepId } : {}),
  ...(trace?.terminalKind ? { terminalKind: trace.terminalKind } : {}),
  ...(trace?.operatorsUnreachable ? { operatorsUnreachable: true } : {}),
})

/**
 * Parse the routine stage's `routine` sub-trace into a renderable, metadata-safe
 * step-by-step view. Carries slot *keys* only — the runner never puts captured
 * values on the trace, and this defensively ignores anything else on the payload.
 * Returns undefined when the stage has no routine sub-trace.
 */
export const buildRoutineRunTrace = (
  stage: ConversationTraceStage,
): RoutineRunTraceView | undefined => {
  const subTrace = stage.subTrace
  if (!subTrace || subTrace.namespace !== 'routine' || !isRecord(subTrace.payload)) {
    return undefined
  }
  const payload = subTrace.payload
  const steps = asArray(payload.steps)
    .filter(isRecord)
    .map((entry): RoutineTraceStepView => {
      const selection = buildRoutineStepSelection(entry.selection)
      const rejectedSlotKeys = rejectedSlotKeysOf(entry.rejectedSlots)
      const replacedSlotKeys = asStringArray(entry.replacedSlotKeys)
      return {
        stepId: asString(entry.stepId) ?? '',
        kind: asString(entry.kind) ?? 'chat',
        event: asString(entry.event) ?? '',
        capturedSlotKeys: asStringArray(entry.capturedSlotKeys),
        ...(replacedSlotKeys.length > 0 ? { replacedSlotKeys } : {}),
        viaSelector: entry.viaSelector === true,
        ...(asString(entry.skillName) ? { skillName: asString(entry.skillName) } : {}),
        ...(asString(entry.skillStatus) ? { skillStatus: asString(entry.skillStatus) } : {}),
        ...(asString(entry.skillReason) ? { skillReason: asString(entry.skillReason) } : {}),
        skillOutcome: skillOutcomeLabel({ status: asString(entry.skillStatus), reason: asString(entry.skillReason) }),
        ...(selection ? { selection } : {}),
        ...(rejectedSlotKeys.length > 0 ? { rejectedSlotKeys } : {}),
        ...(entry.readOpeningMessage === true ? { readOpeningMessage: true } : {}),
      }
    })
  const replacedSlotKeys = asStringArray(payload.replacedSlotKeys)
  return {
    startStepId: asString(payload.startStepId),
    landedStepId: asString(payload.landedStepId),
    terminalKind: asString(payload.terminalKind),
    capturedSlotKeys: asStringArray(payload.capturedSlotKeys),
    ...(replacedSlotKeys.length > 0 ? { replacedSlotKeys } : {}),
    filledSlotKeys: asStringArray(payload.filledSlotKeys),
    ...(payload.operatorsUnreachable === true ? { operatorsUnreachable: true as const } : {}),
    steps,
  }
}
