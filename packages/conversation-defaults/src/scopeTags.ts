export type ParsedScopeTag =
  | { kind: "routine"; routineId: string }
  | { kind: "step"; routineId: string; stepId: string }
  | { kind: "other" };

export const scopeTag = {
  routine: (id: string): string => `routine:${id}`,
  step: (routineId: string, stepId: string): string => `step:${routineId}:${stepId}`,
};

export const parseScopeTag = (tag: string): ParsedScopeTag => {
  if (tag.startsWith("routine:")) {
    const routineId = tag.slice("routine:".length);
    return routineId ? { kind: "routine", routineId } : { kind: "other" };
  }

  if (tag.startsWith("step:")) {
    const [routineId, stepId, extra] = tag.slice("step:".length).split(":");
    if (extra === undefined && routineId && stepId) {
      return { kind: "step", routineId, stepId };
    }
  }

  return { kind: "other" };
};
