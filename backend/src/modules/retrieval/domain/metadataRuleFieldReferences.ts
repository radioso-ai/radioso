/**
 * Reads the metadata field keys a persisted skill config points at.
 *
 * The catalog editor uses this to warn — without blocking — before an operator
 * deletes a field or disables a type whose keys some agent still filters or
 * boosts on. It is deliberately tolerant: a config that predates a schema
 * change, or one whose rules never validated, must never fail the read.
 */

const readFieldKey = (candidate: unknown): string | null => {
  if (!candidate || typeof candidate !== "object") {
    return null;
  }
  const field = (candidate as { field?: unknown }).field;
  return typeof field === "string" && field.trim().length > 0 ? field : null;
};

export const collectMetadataRuleFieldKeys = (config: unknown): string[] => {
  if (!config || typeof config !== "object") {
    return [];
  }

  const rules = (config as { metadataRules?: unknown }).metadataRules;
  if (!Array.isArray(rules)) {
    return [];
  }

  const keys: string[] = [];
  const add = (key: string | null) => {
    if (key && !keys.includes(key)) {
      keys.push(key);
    }
  };

  for (const rule of rules) {
    add(readFieldKey(rule));
    const conditions = (rule as { conditions?: unknown } | null)?.conditions;
    if (Array.isArray(conditions)) {
      for (const condition of conditions) {
        add(readFieldKey(condition));
      }
    }
  }

  return keys;
};
