// What a routine turn's trace records about its slots: the keys each step captured or replaced,
// merged for the turn, and, only when the caller opts in, the values the slots hold after it.
import type {
  Routine,
  RoutineRunTrace,
  RoutineTraceSlotValue,
  RoutineTraceStepEntry,
} from "@radioso/conversation-contract";
import { readableSlotValue, REDACTED_VALUE } from "@radioso/conversation-contract";

const hasVariable = (variables: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(variables, key);

/**
 * One trace entry for a step recorded twice in a turn: once when the turn started on it, again
 * when the walk that follows reached it. The walk's outcome is what happened to the step, so it
 * replaces the start's label, except a render: the walk rendering the step the turn stayed on
 * keeps the start's label, a re-ask or the routine's first ask (#1450).
 */
export const foldStepEntry = (start: RoutineTraceStepEntry, walked: RoutineTraceStepEntry): RoutineTraceStepEntry => {
  const capturedSlotKeys = [...new Set([...(start.capturedSlotKeys ?? []), ...(walked.capturedSlotKeys ?? [])])];
  // A key the start read captured (it held nothing before the turn) and the walk's re-read
  // of the same step later judged "replaced" (against the value the start read just gave it,
  // not against anything held before the turn) is still captured only, as `runSlotKeyFields`
  // treats it at the turn level.
  const replacedSlotKeys = [...new Set([...(start.replacedSlotKeys ?? []), ...(walked.replacedSlotKeys ?? [])])]
    .filter((key) => !capturedSlotKeys.includes(key));
  const rejectedSlots = [...(start.rejectedSlots ?? []), ...(walked.rejectedSlots ?? [])];
  // Drop each entry's own slot-key fields before spreading: the computed, filtered lists
  // below are the source of truth, and a value shrunk to empty (the filter above) must
  // disappear from the folded entry rather than survive from `start` or `walked`.
  const {
    capturedSlotKeys: _startCaptured, replacedSlotKeys: _startReplaced, rejectedSlots: _startRejected, ...startRest
  } = start;
  const {
    capturedSlotKeys: _walkedCaptured, replacedSlotKeys: _walkedReplaced, rejectedSlots: _walkedRejected, ...walkedRest
  } = walked;
  return {
    ...startRest,
    ...walkedRest,
    event: walked.event === "rendered" ? start.event : walked.event,
    ...(capturedSlotKeys.length > 0 ? { capturedSlotKeys } : {}),
    ...(replacedSlotKeys.length > 0 ? { replacedSlotKeys } : {}),
    ...(rejectedSlots.length > 0 ? { rejectedSlots } : {}),
  };
};

/** Whether a value given for a slot is the one it already holds. Slot values are JSON data. */
const sameSlotValue = (held: unknown, given: unknown): boolean =>
  Object.is(held, given)
  || (typeof held === "object" && held !== null && typeof given === "object" && given !== null
    && JSON.stringify(held) === JSON.stringify(given));

/** A step entry's slot keys: those a decision newly filled, and those whose held value it changed. */
export const stepSlotKeyFields = (changes: { captured: string[]; replaced: string[] }): Pick<
  RoutineTraceStepEntry,
  "capturedSlotKeys" | "replacedSlotKeys"
> => ({
  ...(changes.captured.length > 0 ? { capturedSlotKeys: changes.captured } : {}),
  ...(changes.replaced.length > 0 ? { replacedSlotKeys: changes.replaced } : {}),
});

/**
 * The step the turn started on's slot keys, with `replaced` dropped on the routine's first
 * turn (a fresh activation or a completed-routine reentry): there, `changes` was computed
 * against `state.variables`, which is this very turn's own starting point — the activator's
 * extraction from the opening message, or a reentered run's carried-over values — never a
 * value a reply to a rendered step held before. A difference the selector's own re-read of
 * that same message turns up for it is not a replacement of anything held before the turn
 * (#1670 review, finding 2).
 */
export const startStepSlotKeyFields = (
  changes: { captured: string[]; replaced: string[] },
  activationTurn: boolean | undefined,
): Pick<RoutineTraceStepEntry, "capturedSlotKeys" | "replacedSlotKeys"> =>
  stepSlotKeyFields(activationTurn ? { captured: changes.captured, replaced: [] } : changes);

/**
 * The turn's slot keys, from its steps. A slot captured this turn and changed again later in it
 * is listed as captured only: it held no value before the turn.
 */
export const runSlotKeyFields = (steps: readonly RoutineTraceStepEntry[]): Pick<
  RoutineRunTrace,
  "capturedSlotKeys" | "replacedSlotKeys"
> => {
  const capturedSlotKeys = [...new Set(steps.flatMap((entry) => entry.capturedSlotKeys ?? []))];
  const replacedSlotKeys = [...new Set(steps.flatMap((entry) => entry.replacedSlotKeys ?? []))]
    .filter((key) => !capturedSlotKeys.includes(key));
  return { capturedSlotKeys, ...(replacedSlotKeys.length > 0 ? { replacedSlotKeys } : {}) };
};

/**
 * The declared slots a decision gave a value, by key: `captured` held none before it, `replaced`
 * held a different one. A routine that declares no slots counts every key.
 */
export const slotKeyChangesFor = (
  declaredSlotKeys: ReadonlySet<string>,
  before: Record<string, unknown>,
  decision?: { variables?: Record<string, unknown> },
): { captured: string[]; replaced: string[] } => {
  const given = Object.entries(decision?.variables ?? {})
    .filter(([key]) => declaredSlotKeys.size === 0 || declaredSlotKeys.has(key));
  return {
    captured: given.filter(([key]) => !hasVariable(before, key)).map(([key]) => key),
    replaced: given
      .filter(([key, value]) => hasVariable(before, key) && !sameSlotValue(before[key], value))
      .map(([key]) => key),
  };
};

/** Per-value character bound for a traced slot value (including the ellipsis), matching the host's output-bounding magnitude. */
const MAX_TRACE_SLOT_VALUE_CHARS = 500;

/** Filled-slot count bound for one turn's traced slot values. */
const MAX_TRACE_SLOT_VALUES = 50;

/** Narrows a captured slot value to the scalar shape a trace can carry, and caps its length. An item reads as its title. */
const traceableSlotValue = (held: unknown): { value: string | number | boolean; truncated?: boolean } => {
  const value = readableSlotValue(held);
  const scalar = typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? value
    : JSON.stringify(value) ?? String(value);
  if (typeof scalar === "string" && scalar.length > MAX_TRACE_SLOT_VALUE_CHARS) {
    // The ellipsis counts toward the bound, so the kept slice is one character short of it.
    return { value: `${scalar.slice(0, MAX_TRACE_SLOT_VALUE_CHARS - 1)}…`, truncated: true };
  }
  return { value: scalar };
};

/**
 * Every filled declared slot's value after this turn, self-described by its declared
 * type, capped to `MAX_TRACE_SLOT_VALUES` entries with each value capped to
 * `MAX_TRACE_SLOT_VALUE_CHARS`. Called only when the runner's `includeSlotValues`
 * construction option is set — this is the one place the trace carries slot *values*
 * rather than just keys, and it never runs otherwise.
 */
const declaredSlotTraceValues = (
  routine: Routine,
  variables: Record<string, unknown>,
): { slotValues: RoutineTraceSlotValue[]; omittedSlotCount: number } => {
  const filled = (routine.slots ?? []).filter((slot) => hasVariable(variables, slot.key));
  const kept = filled.slice(0, MAX_TRACE_SLOT_VALUES);
  return {
    slotValues: kept.map((slot) => {
      if (slot.sensitivity === "sensitive") {
        return { key: slot.key, type: slot.type, value: REDACTED_VALUE };
      }
      const { value, truncated } = traceableSlotValue(variables[slot.key]);
      return { key: slot.key, type: slot.type, value, ...(truncated ? { truncated: true } : {}) };
    }),
    omittedSlotCount: filled.length - kept.length,
  };
};

/** The `slotValues`/`omittedSlotCount` fields to spread onto a trace, present only when requested. */
export const slotValuesTraceFields = (
  routine: Routine,
  variables: Record<string, unknown>,
  includeSlotValues: boolean | undefined,
): Pick<RoutineRunTrace, "slotValues" | "omittedSlotCount"> => {
  if (!includeSlotValues) {
    return {};
  }
  const { slotValues, omittedSlotCount } = declaredSlotTraceValues(routine, variables);
  return { slotValues, ...(omittedSlotCount > 0 ? { omittedSlotCount } : {}) };
};
