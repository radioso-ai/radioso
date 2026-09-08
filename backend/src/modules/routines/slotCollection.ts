import {
  collectSlotKeys,
  collectedSlotsByStep as collectedSlotsBySteps,
} from "@radioso/routine-definition";

import type { RoutineDefinition } from "./domain.js";

export { collectSlotKeys };

/**
 * Which chat step collects which slots. The rule itself is shared
 * (`@radioso/routine-definition`) so the compiler, the population analysis, and the
 * authoring surfaces cannot disagree about where a slot is captured; this adapter
 * only projects a definition onto it.
 */
export const collectedSlotsByStep = (
  definition: RoutineDefinition,
): ReadonlyMap<string, string[]> => collectedSlotsBySteps(definition.steps);
