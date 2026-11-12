// The values a routine run holds: which of them may enter its state, and how they read in a copy
// that leaves the conversation.
import type { Routine, RoutineTraceRejectedSlot } from "@radioso/conversation-contract";
import { redactSensitiveValues } from "@radioso/conversation-contract";

import { checkSlotValue } from "./slotValue.js";

export const hasVariable = (variables: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(variables, key);

/**
 * Keeps the values that fit their declared slot type, in that type's canonical form (#1374).
 * On a routine with no slot schema there is nothing to check a key against, so every key
 * passes through as it always has. On a routine that declares one, a key the schema does
 * not list is dropped and reported as "undeclared" (#1388) — the turn planner, ranked
 * activation, and a selector return free-form field names, and only a declared slot's
 * value may reach routine state, an action payload, or an unbound tool-step input. A blank
 * value is "not given" and dropped silently; one that does not fit its declared type is
 * dropped and reported by key and reason — never by value.
 */
export const checkDeclaredSlotValues = (
  routine: Routine,
  values: Record<string, unknown>,
): { values: Record<string, unknown>; rejected: RoutineTraceRejectedSlot[] } => {
  const slotTypes = new Map((routine.slots ?? []).map((slot) => [slot.key, slot.type]));
  const kept: Record<string, unknown> = {};
  const rejected: RoutineTraceRejectedSlot[] = [];
  for (const [key, value] of Object.entries(values)) {
    const type = slotTypes.get(key);
    if (!type) {
      if (slotTypes.size > 0) {
        rejected.push({ key, reason: "undeclared" });
      } else {
        kept[key] = value;
      }
      continue;
    }
    const checked = checkSlotValue(type, value);
    if (checked.ok) {
      kept[key] = checked.value;
    } else if (checked.reason !== "empty") {
      rejected.push({ key, reason: checked.reason });
    }
  }
  return { values: kept, rejected };
};

/** The routine's slot keys its author marked sensitive, in declared order. */
export const sensitiveSlotKeys = (routine: Routine): string[] =>
  (routine.slots ?? []).filter((slot) => slot.sensitivity === "sensitive").map((slot) => slot.key);

/**
 * The variables as a copy that leaves the conversation carries them: a sensitive slot's value
 * reads as the redaction marker. The run's own state keeps the value, since the routine needs it
 * to run; every payload, ending, and trace the runner hands out goes through here.
 */
export const outboundVariables = (
  routine: Routine,
  variables: Record<string, unknown>,
): Record<string, unknown> => redactSensitiveValues(variables, sensitiveSlotKeys(routine));

/** The declared slots' values as they leave the conversation, sensitive ones masked. */
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
