import type { Routine, RoutineState } from "@radioso/conversation-contract";

import { consentKeyOfGateStepId } from "./consentGates.js";
import { declaredSlotVariables, sensitiveSlotKeys, type RoutineDefinition } from "./domain.js";
import { collectedSlotsByStep } from "./slotCollection.js";

/**
 * An ended run's declared slot values as they leave the conversation, sensitive ones masked: the
 * engine's own projection, the one completion exports and operator notices send. `sensitiveSlotKeys`
 * names the masked keys from the routine's authored sensitivity, never from a value's text.
 */
export const endedRunValues = (
  routine: Routine,
  variables: Record<string, unknown>,
): { values: Record<string, unknown>; sensitiveSlotKeys: string[] } => {
  const values = declaredSlotVariables(routine, variables);
  const sensitive = new Set(sensitiveSlotKeys(routine));
  return { values, sensitiveSlotKeys: Object.keys(values).filter((key) => sensitive.has(key)) };
};

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
