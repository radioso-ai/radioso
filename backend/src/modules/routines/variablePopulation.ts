import type { RoutineDefinition } from "./domain.js";

const slotReferencePattern = /\{\{\s*slot\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/gu;

const collectSlotReferences = (text: string): string[] => {
  const keys = new Set<string>();
  for (const match of text.matchAll(slotReferencePattern)) {
    const key = match[1];
    if (key) {
      keys.add(key);
    }
  }
  return [...keys];
};

const stepProducers = (step: RoutineDefinition["steps"][number]): ReadonlySet<string> => {
  if (step.kind === "chat") {
    return new Set(collectSlotReferences(step.instruction));
  }
  if (step.kind === "tool") {
    return new Set(Object.values(step.metadata.outputAssignments ?? {}));
  }
  return new Set();
};

const setUnion = (left: ReadonlySet<string>, right: ReadonlySet<string>): Set<string> =>
  new Set([...left, ...right]);

const setIntersection = (sets: ReadonlyArray<ReadonlySet<string>>, universe: ReadonlySet<string>): Set<string> => {
  if (sets.length === 0) {
    return new Set(universe);
  }
  const [first, ...rest] = sets;
  const result = new Set(first);
  for (const candidate of [...result]) {
    if (!rest.every((set) => set.has(candidate))) {
      result.delete(candidate);
    }
  }
  return result;
};

const setsEqual = (left: ReadonlySet<string>, right: ReadonlySet<string>): boolean =>
  left.size === right.size && [...left].every((value) => right.has(value));

export const analyzeGuaranteedVariablesOnEntry = (
  definition: RoutineDefinition,
): ReadonlyMap<string, ReadonlySet<string>> => {
  const steps = [...definition.steps].sort((left, right) => left.ordinal - right.ordinal);
  const entryStepId = steps[0]?.stableStepId;
  const stepIds = new Set(steps.map((step) => step.stableStepId));
  const stepById = new Map(steps.map((step) => [step.stableStepId, step]));
  const producersByStep = new Map(steps.map((step) => [step.stableStepId, stepProducers(step)]));
  const universe = new Set([
    ...definition.slots.map((slot) => slot.key),
    ...steps.flatMap((step) => Object.values(step.metadata.outputAssignments ?? {})),
  ]);
  const predecessorsByStep = new Map<string, string[]>();
  for (const transition of definition.transitions) {
    if (!stepIds.has(transition.fromStep) || !stepIds.has(transition.toRef)) {
      continue;
    }
    predecessorsByStep.set(transition.toRef, [
      ...(predecessorsByStep.get(transition.toRef) ?? []),
      transition.fromStep,
    ]);
  }

  const onEntry = new Map<string, Set<string>>();
  for (const step of steps) {
    onEntry.set(step.stableStepId, step.stableStepId === entryStepId ? new Set() : new Set(universe));
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const step of steps) {
      if (step.stableStepId === entryStepId) {
        continue;
      }
      const predecessors = predecessorsByStep.get(step.stableStepId) ?? [];
      const predecessorExits = predecessors
        .map((predecessorId) => {
          const predecessor = stepById.get(predecessorId);
          if (!predecessor) {
            return null;
          }
          return setUnion(onEntry.get(predecessorId) ?? new Set(), producersByStep.get(predecessorId) ?? new Set());
        })
        .filter((set): set is Set<string> => set !== null);
      const next = setIntersection(predecessorExits, universe);
      const current = onEntry.get(step.stableStepId) ?? new Set();
      if (!setsEqual(current, next)) {
        onEntry.set(step.stableStepId, next);
        changed = true;
      }
    }
  }

  return onEntry;
};
