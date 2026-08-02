import type { AgentContextVariableEnablement, ContextVariableValueType } from "./domain.js";
import { BUILT_IN_CONTEXT_VARIABLES } from "./registry.js";

/**
 * The shape consumers need to type-check a context-variable reference: the name is the
 * map key, the value type is what a binding must be compatible with.
 */
export interface AvailableContextVariable {
  valueType: ContextVariableValueType;
}

/**
 * Merges the built-in context variables with an agent's enabled, joined enablements into the
 * name -> value-type map that authoring-time validation resolves references against.
 *
 * Business rules encoded here:
 * - Only enablements with `enabled === true` contribute.
 * - An enablement whose joined `variable` row is absent is skipped; the join is optional and
 *   can yield an enablement with no variable.
 * - Agent-scoped variables take precedence over built-ins: a workspace variable named after a
 *   built-in (e.g. `page_context`) overrides the built-in's value type rather than being ignored.
 *
 * Pure: callers own the repository read and pass the enablements in.
 */
export function resolveAvailableContextVariables(
  enablements: readonly AgentContextVariableEnablement[],
): ReadonlyMap<string, AvailableContextVariable> {
  const available = new Map<string, AvailableContextVariable>(
    BUILT_IN_CONTEXT_VARIABLES.map((variable) => [variable.name, { valueType: variable.valueType }]),
  );

  for (const enablement of enablements) {
    if (!enablement.enabled || enablement.variable === undefined) {
      continue;
    }
    // Written after the built-ins so agent-scoped definitions win on name collision.
    available.set(enablement.variable.name, { valueType: enablement.variable.valueType });
  }

  return available;
}
