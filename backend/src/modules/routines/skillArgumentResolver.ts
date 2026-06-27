import type { RoutineInputBinding } from "./domain.js";

export const resolveSkillArguments = (
  inputBindings: Record<string, RoutineInputBinding> | undefined,
  variables: Record<string, unknown>,
  contextValues: Record<string, unknown> = {},
): Record<string, unknown> => {
  const collected: Record<string, unknown> = {};
  for (const [inputKey, binding] of Object.entries(inputBindings ?? {})) {
    if (binding.kind === "literal") {
      collected[inputKey] = binding.value;
      continue;
    }
    const value = binding.kind === "variableRef"
      ? variables[binding.ref]
      : contextValues[binding.contextVariable];
    if (value !== undefined) {
      collected[inputKey] = value;
    }
  }
  return collected;
};
