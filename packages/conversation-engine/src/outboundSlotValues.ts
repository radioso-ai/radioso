import type { Routine, RoutineStepReplyInput } from "@radioso/conversation-contract";
import { redactSensitiveValues } from "@radioso/conversation-contract";

// How a routine's slot values read in a copy the runner hands out, the step reply's list of what
// was noted included. The run's own state keeps every value, since the routine needs it to run;
// a copy reads a sensitive slot's value as the redaction marker.

const hasVariable = (variables: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(variables, key);

/** The routine's slot keys its author marked sensitive, in declared order. */
export const sensitiveSlotKeys = (routine: Routine): string[] =>
  (routine.slots ?? []).filter((slot) => slot.sensitivity === "sensitive").map((slot) => slot.key);

/**
 * The variables as a copy that leaves the conversation carries them: a sensitive slot's value
 * reads as the redaction marker. Every payload, ending, and trace the runner hands out goes
 * through here.
 */
export const outboundVariables = (
  routine: Routine,
  variables: Record<string, unknown>,
): Record<string, unknown> => redactSensitiveValues(variables, sensitiveSlotKeys(routine));

/** The declared slots' values as they leave the conversation, in declared order, sensitive ones masked. */
export const declaredSlotVariables = (
  routine: Routine,
  variables: Record<string, unknown>,
): Record<string, unknown> =>
  outboundVariables(
    routine,
    Object.fromEntries(
      (routine.slots ?? [])
        .map((slot) => slot.key)
        .filter((key) => hasVariable(variables, key))
        .map((key) => [key, variables[key]]),
    ),
  );

/**
 * What a step's reply may say was noted (#1666): every declared slot the routine holds, masked as
 * any copy is. A routine that declares no slots has no list to hold a value against, so its reply
 * is given none.
 */
export const heldSlotsForReply = (
  routine: Routine,
  variables: Record<string, unknown>,
): Pick<RoutineStepReplyInput, "heldSlots"> =>
  (routine.slots ?? []).length > 0 ? { heldSlots: declaredSlotVariables(routine, variables) } : {};
