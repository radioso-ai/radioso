/**
 * Pure name->binding resolution for external skills: turn a stored skill
 * definition + the conversation-collected params into the tool-call input.
 *
 * Security: only the definition's declared exposed params are read from
 * `collected`; arbitrary conversation data is never forwarded to the tool. Bound
 * params are fixed by the author and cannot be overridden from the conversation.
 */

export interface ExposedParamSpec {
  /** Optional explicit routine slot to read instead of the param's own name. */
  slotBinding?: string;
}

export interface SkillBinding {
  toolName: string;
  boundParams: Record<string, unknown>;
  exposedParams: Record<string, ExposedParamSpec>;
}

/**
 * Merge bound params (author-fixed) with conversation-filled exposed params.
 * Each exposed param is read from `collected[slotBinding ?? paramName]`; values
 * that are absent are omitted (the tool/skill decides how to handle missing
 * optional inputs). Bound and exposed key sets are disjoint by construction
 * (enforced in the domain schema), so there is no override ambiguity.
 */
export const mergeToolInput = (
  binding: SkillBinding,
  collected: Record<string, unknown>,
): Record<string, unknown> => {
  const input: Record<string, unknown> = { ...binding.boundParams };
  for (const [paramName, spec] of Object.entries(binding.exposedParams)) {
    const source = spec.slotBinding ?? paramName;
    const value = collected[source];
    if (value !== undefined) {
      input[paramName] = value;
    }
  }
  return input;
};
