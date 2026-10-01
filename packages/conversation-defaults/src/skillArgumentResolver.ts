import type { RoutineInputBinding, SkillArgumentOrigin } from "@radioso/conversation-contract";

/** A routine skill step's arguments, and where each one came from, keyed alike. */
export interface ResolvedSkillArguments {
  values: Record<string, unknown>;
  origins: Record<string, SkillArgumentOrigin>;
}

/**
 * Collects the arguments a routine skill step passes to its skill from the step's
 * authored input bindings: a literal value, a routine variable, or a turn context
 * variable. Purely a lookup — it knows nothing about any concrete skill, transport,
 * or product-specific context variable, so both the Radioso backend and a kit host
 * resolve arguments the same way. Each argument's origin rides alongside it, so an
 * executor can treat a value the author wrote differently from one a visitor supplied.
 *
 * A `variableRef`/`contextVariableRef` that resolves to `undefined` is omitted rather
 * than passed as an explicit `undefined`, so an unfilled slot leaves the skill's own
 * default in place. A literal is always included.
 */
export const resolveSkillArguments = (
  inputBindings: Record<string, RoutineInputBinding> | undefined,
  variables: Record<string, unknown>,
  contextValues: Record<string, unknown> = {},
): ResolvedSkillArguments => {
  const values: Record<string, unknown> = {};
  const origins: Record<string, SkillArgumentOrigin> = {};
  for (const [inputKey, binding] of Object.entries(inputBindings ?? {})) {
    if (binding.kind === "literal") {
      values[inputKey] = binding.value;
      origins[inputKey] = "literal";
      continue;
    }
    const value = binding.kind === "variableRef"
      ? variables[binding.ref]
      : contextValues[binding.contextVariable];
    if (value !== undefined) {
      values[inputKey] = value;
      origins[inputKey] = binding.kind === "variableRef" ? "slot" : "context";
    }
  }
  return { values, origins };
};

/**
 * The arguments of a skill step that authors no input bindings: the routine's variables,
 * passed through wholesale, each one a `slot`.
 */
export const resolveUntypedSkillArguments = (variables: Record<string, unknown>): ResolvedSkillArguments => {
  const origins: Record<string, SkillArgumentOrigin> = {};
  for (const key of Object.keys(variables)) {
    origins[key] = "slot";
  }
  return { values: variables, origins };
};
