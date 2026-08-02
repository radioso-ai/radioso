import type { RoutineInputBinding } from "@radioso/conversation-contract";

/**
 * Collects the arguments a routine skill step passes to its skill from the step's
 * authored input bindings: a literal value, a routine variable, or a turn context
 * variable. Purely a lookup — it knows nothing about any concrete skill, transport,
 * or product-specific context variable, so both the Radioso backend and a kit host
 * resolve arguments the same way.
 *
 * A `variableRef`/`contextVariableRef` that resolves to `undefined` is omitted rather
 * than passed as an explicit `undefined`, so an unfilled slot leaves the skill's own
 * default in place. A literal is always included.
 */
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
