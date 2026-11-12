import type {
  Routine,
  RoutinePendingStep,
  RoutineStep,
  RoutineStepReask,
  RoutineTraceRejectedSlot,
} from "@radioso/conversation-contract";

import { collectedSlotsForStep, requiredCollectedSlots } from "./slotCollectionStep.js";
import { STEP_REFERENCE } from "./stepReferences.js";

const hasVariable = (variables: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(variables, key);

/**
 * The rejected keys that belong to slots this step collects. A value kept out for want of
 * consent (#1544) says nothing about the visitor's answer to the step, so it is not among them.
 */
export const rejectedCollectedKeys = (step: RoutineStep, rejected: readonly RoutineTraceRejectedSlot[]): Set<string> => {
  const collected = new Set(collectedSlotsForStep(step));
  return new Set(rejected.filter((slot) => slot.reason !== "consent").map((slot) => slot.key).filter((key) => collected.has(key)));
};

/**
 * Whether the turn filled a slot the step collects that was empty before it: progress that
 * resets the re-ask count. Replacing a value the step already held is not progress, or a
 * visitor restating an optional value with each failed answer would never reach the limit.
 */
export const filledCollectedSlot = (
  step: RoutineStep,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): boolean =>
  collectedSlotsForStep(step).some((key) => !hasVariable(before, key) && hasVariable(after, key));

/**
 * What a re-rendered step still lacks: its required collected slots that are unfilled, and
 * any collected slot whose value this turn was rejected for not fitting its type, as
 * declared schema — never values. `null` when the step collects required slots, holds them
 * all, and rejected nothing: it stayed for another reason, and telling the renderer the reply
 * "fell short" made it ask again for values it already had. An optional slot counts as
 * missing only when its value was rejected. A reply the runner could not read (`replyUnread`)
 * is always named, since it may have answered the step (#1715). A slot in `waived` is never
 * missing: the routine runs without it, because its consent was declined or withdrawn (#1544).
 */
export const reaskFor = (
  routine: Routine,
  step: RoutineStep,
  variables: Record<string, unknown>,
  rejectedKeys: ReadonlySet<string>,
  replyUnread: boolean,
  waived: ReadonlySet<string>,
): RoutineStepReask | null => {
  const collected = new Set(collectedSlotsForStep(step));
  const required = requiredCollectedSlots(routine, step);
  const missingSlots = (routine.slots ?? []).filter((slot) =>
    collected.has(slot.key) && !waived.has(slot.key) &&
    (rejectedKeys.has(slot.key) || (slot.required && !hasVariable(variables, slot.key))),
  );
  if (replyUnread) {
    return { missingSlots, replyUnreadable: true };
  }
  return required.length > 0 && missingSlots.length === 0 ? null : { missingSlots };
};

/**
 * The step a yielding routine stays parked on. The host puts it into the answer's system
 * prompt, so it carries no captured value: a captured value is visitor text, and a slot
 * reference shows as its bracketed key instead ("Ask [name] for the dates"). The routine
 * claims nothing this turn, so the context staged for the turn (the visitor's page) is not
 * the routine's to read either, and a context reference renders empty. A slot the routine runs
 * without (`waived`, #1544) is not missing.
 */
export const pendingStepFor = (
  routine: Routine,
  step: RoutineStep,
  variables: Record<string, unknown>,
  waived: ReadonlySet<string>,
): RoutinePendingStep => ({
  stepId: step.id,
  instruction: (step.action ?? "").replace(STEP_REFERENCE, (_match, kind: string, name: string) =>
    kind === "slot" ? `[${name}]` : ""),
  missingSlotKeys: requiredCollectedSlots(routine, step)
    .filter((slot) => !hasVariable(variables, slot.key) && !waived.has(slot.key))
    .map((slot) => slot.key),
});
