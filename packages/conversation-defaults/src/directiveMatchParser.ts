import type { DirectiveClassification } from "@radioso/conversation-contract";

const clampConfidence = (value: unknown): number | null => {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return Math.min(1, Math.max(0, numeric));
};

/** Extracts the first JSON array from a model response that may carry prose or code fences. */
const extractJsonArray = (raw: string): unknown => {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) {
    return null;
  }
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
};

/**
 * Parses the model's structured directive-match output. Keeps only entries
 * whose `name` is a known candidate, clamps confidence to [0, 1], and tolerates
 * surrounding prose or unparseable output (returns an empty array).
 */
export const parseDirectiveClassifications = (
  raw: string,
  candidateNames: string[],
): DirectiveClassification[] => {
  const parsed = extractJsonArray(raw);
  if (!Array.isArray(parsed)) {
    return [];
  }

  const known = new Set(candidateNames);
  const classifications: DirectiveClassification[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name : null;
    const confidence = clampConfidence(record.confidence);
    if (!name || !known.has(name) || confidence === null) {
      continue;
    }
    const reason = typeof record.reason === "string" && record.reason.trim() ? record.reason.trim() : undefined;
    classifications.push(reason ? { name, confidence, reason } : { name, confidence });
  }
  return classifications;
};
