const byteLength = (value: unknown): number => Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");

/** Shortens a string to fit `budget` bytes once serialized, cutting on a character boundary. */
const fitString = (value: string, budget: number): string | undefined => {
  if (budget < 3) return undefined;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (byteLength(value.slice(0, mid)) <= budget) low = mid;
    else high = mid - 1;
  }
  return value.slice(0, low);
};

/** One value cut to fit `budget` serialized bytes, or undefined when nothing of it fits. */
const fitValue = (value: unknown, budget: number): unknown => {
  if (byteLength(value) <= budget) return value;
  if (typeof value === "string") return fitString(value, budget);
  if (Array.isArray(value)) {
    const items: unknown[] = [];
    for (const item of value) {
      const remaining = budget - byteLength(items) - 1;
      const fitted = fitValue(item, remaining);
      if (fitted === undefined) break;
      items.push(fitted);
      if (fitted !== item) break;
    }
    return items;
  }
  if (typeof value === "object" && value !== null) {
    const entries: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const remaining = budget - byteLength(entries) - byteLength(key) - 2;
      const fitted = fitValue(item, remaining);
      if (fitted === undefined) break;
      entries[key] = fitted;
      if (fitted !== item) break;
    }
    return entries;
  }
  return undefined;
};

/**
 * A parsed body cut down to `maxBytes` once serialized, for the operator choosing output paths: it
 * keeps the body's shape and its first entries, shortening the entry where the budget runs out.
 */
export const previewJsonBody = (body: unknown, maxBytes: number): { body: unknown; truncated: boolean } => {
  if (byteLength(body) <= maxBytes) return { body, truncated: false };
  return { body: fitValue(body, maxBytes) ?? null, truncated: true };
};
