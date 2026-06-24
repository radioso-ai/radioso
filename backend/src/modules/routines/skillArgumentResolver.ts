import type { RoutineInputBinding } from "./domain.js";

export const resolveSkillArguments = (
  inputBindings: Record<string, RoutineInputBinding> | undefined,
  variables: Record<string, unknown>,
): Record<string, unknown> => {
  const collected: Record<string, unknown> = {};
  for (const [inputKey, binding] of Object.entries(inputBindings ?? {})) {
    if (binding.kind === "literal") {
      collected[inputKey] = binding.value;
      continue;
    }
    const value = variables[binding.ref];
    if (value !== undefined) {
      collected[inputKey] = value;
    }
  }
  return collected;
};
