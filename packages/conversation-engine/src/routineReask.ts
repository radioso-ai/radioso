import type { Routine, RoutineSelectionTrace, RoutineStep, RoutineStepReask } from "@radioso/conversation-contract";

import { collectedSlotsForStep, requiredCollectedSlots } from "./slotCollectionStep.js";

const hasVariable = (variables: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(variables, key);

/** Whether the selector could not read the reply at all: its decision was unreadable and no slot-only reading recovered it. */
const replyUnread = (selection: RoutineSelectionTrace | undefined): boolean =>
  selection?.outcome === "unreadable" && selection.slotFallback !== "read";

/**
 * What a re-rendered step still lacks: its required collected slots that are unfilled, and
 * any collected slot whose value this turn was rejected for not fitting its type, as
 * declared schema — never values. `null` when the step collects required slots, holds them
 * all, and rejected nothing: it stayed for another reason, and telling the renderer the reply
 * "fell short" made it ask again for values it already had. An optional slot counts as
 * missing only when its value was rejected. A reply the selector could not read (`selection`
 * is the answered step's) is always named, since it may have answered the step (#1715).
 */
export const reaskFor = (
  routine: Routine,
  step: RoutineStep,
  variables: Record<string, unknown>,
  rejectedKeys: ReadonlySet<string>,
  selection: RoutineSelectionTrace | undefined,
): RoutineStepReask | null => {
  const collected = new Set(collectedSlotsForStep(step));
  const required = requiredCollectedSlots(routine, step);
  const missingSlots = (routine.slots ?? []).filter((slot) =>
    collected.has(slot.key) && (rejectedKeys.has(slot.key) || (slot.required && !hasVariable(variables, slot.key))),
  );
  if (replyUnread(selection)) {
    return { missingSlots, replyUnreadable: true };
  }
  return required.length > 0 && missingSlots.length === 0 ? null : { missingSlots };
};
