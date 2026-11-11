import type { ChatRoutineTurnReporter } from "../contracts/routineTurnState.js";
import type { CapturedRoutineTransition } from "./routines/deferredRoutineStore.js";

/**
 * The sensitive slots (#1543) the routine this turn saved holds a value for, and those the step
 * the turn started on asks for (the visitor's message answers it, stored or not). Both messages
 * of such a turn are marked, so every copy of the transcript that leaves reads them as withheld.
 */
export const sensitiveSlotKeysForTurn = (input: {
  routineStateTransition?: CapturedRoutineTransition | null;
  routineReporter?: ChatRoutineTurnReporter;
}): string[] => {
  const { routineReporter: reporter, routineStateTransition: transition } = input;
  if (!reporter || !transition) return [];
  const held = transition.kind === "save" ? reporter.sensitiveSlotKeysHeld(transition.state) : [];
  const awaited = transition.startedFrom ? reporter.sensitiveSlotKeysAwaited(transition.startedFrom) : [];
  return [...new Set([...held, ...awaited])];
};
