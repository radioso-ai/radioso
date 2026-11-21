import type { ConversationTraceStage } from '@/lib/api'
import { skillOutcomeLabel } from '@/lib/skill-dispatch-outcome'

/**
 * Reads a routine stage's `routine` sub-trace into the step-by-step view the turn inspector
 * renders. Steps carry slot keys only. The filled slots' values come through only when the
 * trace carries them (`slotValues`, which a Test Chat turn's trace has and a conversation's
 * never does); the reader ignores anything else on the payload.
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

/** What a consent step did (#1544): the consent's key and codes only, never its wording or the reply. */
interface RoutineStepConsentView {
  key: string
  decision?: 'granted' | 'declined'
  defaulted?: true
  reask?: true
  reason?: string
}

const buildRoutineStepConsent = (value: unknown): RoutineStepConsentView | undefined => {
  if (!isRecord(value)) return undefined
  const key = asString(value.key)
  if (!key) return undefined
  const decision = value.decision === 'granted' || value.decision === 'declined' ? value.decision : undefined
  const reason = asString(value.reason)
  return {
    key,
    ...(decision ? { decision } : {}),
    ...(value.defaulted === true ? { defaulted: true as const } : {}),
    ...(value.reask === true ? { reask: true as const } : {}),
    ...(reason ? { reason } : {}),
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
  /** Slots whose returned value was not stored, each with why (#1374, #1388, #1544). */
  rejectedSlots?: RoutineRejectedSlotView[]
  /** On the routine's first turn, this step read the opening message before it was asked (#1370). */
  readOpeningMessage?: boolean
  /** On a consent step, what became of the consent this turn (#1544). */
  consent?: RoutineStepConsentView
}

export const REJECTED_SLOT_REASONS = ['undeclared', 'consent', 'type_mismatch', 'not_scalar'] as const
const KNOWN_REJECTED_SLOT_REASONS: readonly unknown[] = REJECTED_SLOT_REASONS
export type RejectedSlotReason = (typeof REJECTED_SLOT_REASONS)[number] | 'unknown'

export interface RoutineRejectedSlotView {
  key: string
  reason: RejectedSlotReason
}

const isKnownRejectedSlotReason = (value: unknown): value is Exclude<RejectedSlotReason, 'unknown'> =>
  KNOWN_REJECTED_SLOT_REASONS.includes(value)

// Key and reason only: the runner never puts a rejected value on the trace, and this ignores one
// if present. A reason this view does not know reads as `unknown`, so the key still shows.
const rejectedSlotsOf = (value: unknown): RoutineRejectedSlotView[] =>
  asArray(value).flatMap((entry) => {
    const key = isRecord(entry) ? asString(entry.key) : undefined
    const reason = isRecord(entry) ? entry.reason : undefined
    return key ? [{ key, reason: isKnownRejectedSlotReason(reason) ? reason : 'unknown' }] : []
  })

/**
 * A filled slot's value as the trace carries it: a sensitive slot's reads as the redaction mark,
 * and one cut to the trace's length bound already ends in "…".
 */
interface RoutineSlotValueView {
  key: string
  value: string
}

// Scalars only, as the runner writes them; an entry of any other shape is dropped.
const slotValuesOf = (value: unknown): RoutineSlotValueView[] =>
  asArray(value).flatMap((entry) => {
    if (!isRecord(entry)) return []
    const key = asString(entry.key)
    const slotValue = entry.value
    if (!key || !(typeof slotValue === 'string' || typeof slotValue === 'number' || typeof slotValue === 'boolean')) {
      return []
    }
    return [{ key, value: String(slotValue) }]
  })

export interface RoutineRunTraceView {
  startStepId?: string
  landedStepId?: string
  terminalKind?: string
  capturedSlotKeys: string[]
  /** Slot keys that held a value before the turn and were given a different one. */
  replacedSlotKeys?: string[]
  filledSlotKeys: string[]
  /** Each filled slot's value after the turn, present only on a trace that carries them (Test Chat). */
  slotValues?: RoutineSlotValueView[]
  /** Filled slots past the trace's count bound, whose values it left out. */
  omittedSlotCount?: number
  steps: RoutineTraceStepView[]
}

/**
 * Parse the routine stage's `routine` sub-trace into a renderable step-by-step view.
 * Steps carry slot *keys* only; the turn's filled slot values come through only when
 * the trace carries them, and this defensively ignores anything else on the payload.
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
      const rejectedSlots = rejectedSlotsOf(entry.rejectedSlots)
      const replacedSlotKeys = asStringArray(entry.replacedSlotKeys)
      const consent = buildRoutineStepConsent(entry.consent)
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
        ...(rejectedSlots.length > 0 ? { rejectedSlots } : {}),
        ...(entry.readOpeningMessage === true ? { readOpeningMessage: true } : {}),
        ...(consent ? { consent } : {}),
      }
    })
  const replacedSlotKeys = asStringArray(payload.replacedSlotKeys)
  const omittedSlotCount = asNumber(payload.omittedSlotCount)
  return {
    startStepId: asString(payload.startStepId),
    landedStepId: asString(payload.landedStepId),
    terminalKind: asString(payload.terminalKind),
    capturedSlotKeys: asStringArray(payload.capturedSlotKeys),
    ...(replacedSlotKeys.length > 0 ? { replacedSlotKeys } : {}),
    filledSlotKeys: asStringArray(payload.filledSlotKeys),
    ...(Array.isArray(payload.slotValues) ? { slotValues: slotValuesOf(payload.slotValues) } : {}),
    ...(omittedSlotCount !== undefined && omittedSlotCount > 0 ? { omittedSlotCount } : {}),
    steps,
  }
}
