const isPlainConfigObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Deep-merges a `config` patch into a stored `config`: recurses into plain objects on both
 * sides so an untouched sibling key survives, but replaces arrays and scalars outright wherever
 * the patch supplies them. A shallow top-level merge lets a patch that only names one nested
 * settings path (e.g. notify's `delivery.recipientEmails`) silently wipe a sibling path under the
 * same key (`delivery.webhook`) that the patch never mentioned, because the whole `delivery`
 * object would be replaced wholesale. "Append to this array" is not a merge rule this function can
 * safely infer, so an array in the patch always replaces the corresponding array wholesale.
 *
 * Shared by the direct HTTP PATCH path (`AgentSkillRepository.update`, which must run this
 * against the current stored row inside one transaction to avoid a lost update) and the operator
 * copilot proposal adapter (which always applies through a full `replaceConfig`, so it merges
 * against the row it read while drafting instead).
 */
export const mergeSkillConfig = (
  existing: Record<string, unknown> | undefined,
  patch: Record<string, unknown> | undefined,
): Record<string, unknown> => {
  const base = existing ?? {};
  const overlay = patch ?? {};
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const current = base[key];
    merged[key] = isPlainConfigObject(value) && isPlainConfigObject(current)
      ? mergeSkillConfig(current, value)
      : value;
  }
  return merged;
};
