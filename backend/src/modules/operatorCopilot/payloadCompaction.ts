export const MAX_STRING_CHARS = 500;
export const MAX_ARRAY_ITEMS = 40;

export type TruncationReason = "string_length" | "array_length" | "budget_omitted";

export interface TruncationEntry {
  path: string;
  reason: TruncationReason;
  originalLength?: number;
  retainedLength?: number;
}

export interface CompactionOptions {
  maxStringChars: number;
  maxArrayItems: number;
}

export interface CompactionResult<T> {
  value: T;
  truncation: TruncationEntry[];
}

export const serializedLength = (value: unknown): number => JSON.stringify(value).length;

const appendPath = (path: string, key: string): string => `${path}.${key}`;

const compactValue = (
  value: unknown,
  options: CompactionOptions,
  path: string,
  truncation: TruncationEntry[],
): unknown => {
  if (typeof value === "string") {
    if (value.length <= options.maxStringChars) return value;
    truncation.push({
      path,
      reason: "string_length",
      originalLength: value.length,
      retainedLength: options.maxStringChars,
    });
    return `${value.slice(0, options.maxStringChars)}…`;
  }
  if (Array.isArray(value)) {
    if (value.length > options.maxArrayItems) {
      truncation.push({
        path,
        reason: "array_length",
        originalLength: value.length,
        retainedLength: options.maxArrayItems,
      });
    }
    return value.slice(0, options.maxArrayItems).map((entry, index) =>
      compactValue(entry, options, `${path}[${index}]`, truncation));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      compactValue(entry, options, appendPath(path, key), truncation),
    ]));
  }
  return value;
};

export const compactRecord = <T extends Record<string, unknown>>(
  payload: T,
  options: CompactionOptions,
  initialTruncation: ReadonlyArray<TruncationEntry> = [],
): CompactionResult<T> => {
  const truncation = [...initialTruncation];
  return {
    value: compactValue(payload, options, "$", truncation) as T,
    truncation,
  };
};

export const withTruncation = <T extends Record<string, unknown>>(
  payload: T,
  truncation: ReadonlyArray<TruncationEntry>,
): T => truncation.length === 0
  ? payload
  : {
      ...payload,
      truncation: {
        truncated: true,
        entries: truncation,
      },
    } as T;

const fitsBudget = <T extends Record<string, unknown>>(
  result: CompactionResult<T>,
  charBudget: number,
): boolean => serializedLength(withTruncation(result.value, result.truncation)) <= charBudget;

/**
 * How much of each dimension one tightening step keeps.
 *
 * Shallow enough that the first profile to fit lands near the budget rather than far under it: the
 * payloads that reach this search are the large diagnostic ones, where the difference between
 * landing at half the budget and landing near it is detail an operator asked to see. `Math.floor`
 * of any ratio below 1 strictly decreases every positive integer, so the search still terminates.
 */
const TIGHTENING_RATIO = 0.75;

/** The next profile down, or `null` once nothing is left to tighten. */
const tightened = (profile: CompactionOptions): CompactionOptions | null =>
  profile.maxStringChars === 0 && profile.maxArrayItems === 0
    ? null
    : {
        maxStringChars: Math.floor(profile.maxStringChars * TIGHTENING_RATIO),
        maxArrayItems: Math.floor(profile.maxArrayItems * TIGHTENING_RATIO),
      };

/**
 * Compacts a payload to fit `charBudget`, keeping the most generous profile that fits.
 *
 * The supplied profiles are where the search starts, not where it stops. A caller's ladder is a
 * statement about what it would *like* to keep — full strings for a diagnostic spine, say — and a
 * payload can always arrive with more collections than the ladder's author imagined. Stopping at
 * the last rung would return a payload over the budget, and the budget's whole purpose is to bound
 * what a single tool result costs the turn that reads it, so tightening continues past the ladder
 * until the payload fits.
 *
 * Post-condition: the returned value, with its truncation record attached, serializes within
 * `charBudget` for any budget large enough to hold an empty marked-truncated record.
 */
export const compactForBudget = <T extends Record<string, unknown>>(
  payload: T,
  profiles: ReadonlyArray<CompactionOptions>,
  charBudget: number,
  initialTruncation: ReadonlyArray<TruncationEntry> = [],
): CompactionResult<T> => {
  for (const profile of profiles) {
    const result = compactRecord(payload, profile, initialTruncation);
    if (fitsBudget(result, charBudget)) return result;
  }

  let profile = tightened(profiles.at(-1) ?? { maxStringChars: MAX_STRING_CHARS, maxArrayItems: MAX_ARRAY_ITEMS });
  while (profile) {
    const result = compactRecord(payload, profile, initialTruncation);
    if (fitsBudget(result, charBudget)) return result;
    profile = tightened(profile);
  }

  // Nothing of this payload's shape survives the budget — its breadth is in its keys rather than
  // in the strings and arrays compaction can shrink. Say so, rather than returning the oversized
  // payload the caller asked not to be given.
  return { value: {} as T, truncation: [{ path: "$", reason: "budget_omitted" }] };
};

/**
 * Generic model-result compaction shared by every copilot family reader. It
 * bounds scalar and collection fan-out without making the copilot depend on a
 * particular owning module's result shape.
 */
export const boundPayload = <T extends Record<string, unknown>>(payload: T): T =>
  compactRecord(payload, { maxStringChars: MAX_STRING_CHARS, maxArrayItems: MAX_ARRAY_ITEMS }).value;
