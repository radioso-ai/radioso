import type { RoutineState } from "@radioso/conversation-contract";

import { consentKeyOfGateStepId } from "./consentGates.js";
import type { RoutineDefinition } from "./domain.js";
import { collectedSlotsByStep } from "./slotCollection.js";

/**
 * The sensitive slots (#1543) the step a routine state waits on collects. The visitor's next
 * message answers that step, so it can hold the value whether or not the turn manages to store
 * it (a value the selector misses or rejects, a turn that fails or is cut off). Read from the
 * state the turn starts on, so the message can be marked before anything copies it. Empty when
 * the state's routine is not among `definitions` or the step collects no sensitive slot.
 */
export const sensitiveSlotsAwaited = (
  definitions: readonly RoutineDefinition[],
  state: Pick<RoutineState, "routineId" | "path">,
): string[] => {
  const definition = definitions.find((candidate) => candidate.id === state.routineId);
  if (!definition) return [];
  // The path records real advances only, so an empty one is still on the root step.
  const rootStepId = [...definition.steps].sort((left, right) => left.ordinal - right.ordinal)[0]?.stableStepId;
  const currentStepId = state.path.at(-1) ?? rootStepId;
  // A consent step waits on the answer to a consent, which may already state a value it covers.
  const consentKey = currentStepId ? consentKeyOfGateStepId(currentStepId) : null;
  const collected = new Set(consentKey !== null
    ? definition.consents?.find((consent) => consent.key === consentKey)?.slotKeys ?? []
    : currentStepId ? collectedSlotsByStep(definition).get(currentStepId) ?? [] : []);
  return definition.slots
    .filter((slot) => slot.sensitivity === "sensitive" && collected.has(slot.key))
    .map((slot) => slot.key);
};
