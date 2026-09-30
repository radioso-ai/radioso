import type { ConversationTrace, RoutineSlotType, RoutineTraceSlotValue } from "@radioso/conversation-contract";

/** Shown in place of a PII-typed slot's value on a customer-facing trace surface. */
export const REDACTED_SLOT_VALUE_PLACEHOLDER = "[redacted]";

/**
 * Declared slot types whose captured value can directly identify a person. A customer
 * conversation's trace surface masks these; a private Test Chat turn shows every value in
 * full. This is the single place that decides it, so extending it (a future PII-carrying
 * slot type) changes redaction everywhere at once rather than at each reader.
 */
const PII_SLOT_TYPES: ReadonlySet<RoutineSlotType> = new Set(["email"]);

export const isPiiRoutineSlotType = (type: RoutineSlotType): boolean => PII_SLOT_TYPES.has(type);

/** Replaces every PII-typed slot's value with the redaction placeholder; other slots pass through unchanged. */
export const maskPiiRoutineSlotValues = (
  slotValues: readonly RoutineTraceSlotValue[],
): RoutineTraceSlotValue[] =>
  slotValues.map((entry) =>
    isPiiRoutineSlotType(entry.type) ? { ...entry, value: REDACTED_SLOT_VALUE_PLACEHOLDER } : entry);

const isRoutineTraceSlotValueArray = (value: unknown): value is RoutineTraceSlotValue[] => Array.isArray(value);

/**
 * Applies {@link maskPiiRoutineSlotValues} to every routine sub-trace hanging off a turn's
 * spine. A customer conversation's `turn_trace` calls this before the spine leaves the chat
 * module; a Test Chat turn's trace is never passed through it, so its slot values stay in
 * full. Returns a new spine (and new stage objects where masking applied); the input is
 * never mutated.
 */
export const maskRoutineSubTracesForCustomerSurface = (spine: ConversationTrace): ConversationTrace => ({
  ...spine,
  stages: spine.stages.map((stage) => {
    const subTrace = stage.subTrace;
    if (!subTrace || subTrace.namespace !== "routine" || typeof subTrace.payload !== "object" || subTrace.payload === null) {
      return stage;
    }
    const payload = subTrace.payload as Record<string, unknown>;
    if (!isRoutineTraceSlotValueArray(payload.slotValues)) {
      return stage;
    }
    return {
      ...stage,
      subTrace: {
        ...subTrace,
        payload: { ...payload, slotValues: maskPiiRoutineSlotValues(payload.slotValues) },
      },
    };
  }),
});
