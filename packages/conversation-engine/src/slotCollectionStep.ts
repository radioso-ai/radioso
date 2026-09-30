import type { Routine, RoutineSlotSchema, RoutineStep, RoutineTransition } from "@radioso/conversation-contract";

/** Reads a step's declared `collectsSlots` metadata: the slot keys it is responsible for capturing. */
export const collectedSlotsForStep = (step: RoutineStep): string[] => {
  const value = step.metadata?.collectsSlots;
  return Array.isArray(value) && value.every((candidate): candidate is string => typeof candidate === "string")
    ? value
    : [];
};

const hasVariable = (variables: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(variables, key);

/** The step's collected slots that are also declared required on the routine. */
export const requiredCollectedSlots = (routine: Routine, step: RoutineStep): RoutineSlotSchema[] => {
  const collected = new Set(collectedSlotsForStep(step));
  return (routine.slots ?? []).filter((slot) => slot.required && collected.has(slot.key));
};

export const slotFilledGuardPasses = (transition: RoutineTransition, variables: Record<string, unknown>): boolean =>
  transition.guard?.kind === "slot_filled" &&
  transition.guard.slots.length > 0 &&
  transition.guard.slots.every((slot) => hasVariable(variables, slot));

/**
 * A slot-collection step has nothing left to ask when its required collected slots are
 * filled (every collected slot, if it collects only optional ones), or when one of its
 * `slot_filled` exits already passes. An optional slot never holds a step (#1371).
 * The runner and the turn reporter share this rule and apply their own step-kind gate.
 */
export const isSlotCollectionStepSatisfied = (
  routine: Routine,
  step: RoutineStep,
  variables: Record<string, unknown>,
): boolean => {
  const collectedSlots = collectedSlotsForStep(step);
  if (collectedSlots.length === 0) {
    return false;
  }
  const requiredSlots = requiredCollectedSlots(routine, step).map((slot) => slot.key);
  const holdingSlots = requiredSlots.length > 0 ? requiredSlots : collectedSlots;
  const exits = routine.transitions.filter((transition) => transition.from === step.id);
  return (
    holdingSlots.every((key) => hasVariable(variables, key)) ||
    exits.some((exit) => slotFilledGuardPasses(exit, variables))
  );
};
