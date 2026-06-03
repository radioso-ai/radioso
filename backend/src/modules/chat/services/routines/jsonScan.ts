/**
 * Extracts the first balanced `{ ... }` object from model output (it may wrap the JSON
 * in prose or a code fence). A string-aware balanced scan — not a greedy `{.*}` regex —
 * so trailing prose, a second object, nested braces, and braces *inside a captured
 * value* (e.g. a user message containing "}") don't truncate or capture the wrong span.
 * Structural parsing only — no product vocabulary.
 */
export const extractFirstJsonObject = (raw: string): string | null => {
  const start = raw.indexOf("{");
  if (start < 0) {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return raw.slice(start, index + 1);
      }
    }
  }
  return null;
};
