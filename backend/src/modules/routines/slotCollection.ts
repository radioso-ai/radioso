import type { RoutineDefinition } from "./domain.js";

const slotReferencePattern = /\{\{\s*slot\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/gu;

/** Extract the distinct `{{slot.<key>}}` references from an instruction, in first-seen order. */
export const collectSlotKeys = (instruction: string): string[] => {
  const keys = new Set<string>();
  for (const match of instruction.matchAll(slotReferencePattern)) {
    const key = match[1];
    if (key) {
      keys.add(key);
    }
  }
  return [...keys];
};

/**
 * Which chat step collects which slots, by the single rule shared across the
 * routine pipeline:
 *
 * A slot is *collected* by the FIRST chat step (in ordinal order) that references
 * `{{slot.x}}`; a later reference is a *use* (interpolation), not a re-collection.
 * Only `chat` steps collect from the customer.
 *
 * The compiler uses this to auto-gate the collecting step and to stamp `collectsSlots`
 * metadata; the population analysis uses it to decide which step *produces* a variable.
 * They MUST agree — if they don't, the guaranteed-population analysis can mark a variable
 * available on a path where the runtime never actually collected it, defeating the
 * "typed mode has no runtime input gaps" guarantee (spec FR-010 / R7).
 *
 * Returns only the steps that collect at least one slot, keyed by `stableStepId`.
 */
export const collectedSlotsByStep = (
  definition: RoutineDefinition,
): ReadonlyMap<string, string[]> => {
  const sortedSteps = [...definition.steps].sort((left, right) => left.ordinal - right.ordinal);
  const firstReferencerByKey = new Map<string, string>();
  for (const step of sortedSteps) {
    if (step.kind !== "chat") {
      continue;
    }
    for (const key of collectSlotKeys(step.instruction)) {
      if (!firstReferencerByKey.has(key)) {
        firstReferencerByKey.set(key, step.stableStepId);
      }
    }
  }

  const collectedByStep = new Map<string, string[]>();
  for (const step of sortedSteps) {
    if (step.kind !== "chat") {
      continue;
    }
    const collected = collectSlotKeys(step.instruction).filter(
      (key) => firstReferencerByKey.get(key) === step.stableStepId,
    );
    if (collected.length > 0) {
      collectedByStep.set(step.stableStepId, collected);
    }
  }
  return collectedByStep;
};
