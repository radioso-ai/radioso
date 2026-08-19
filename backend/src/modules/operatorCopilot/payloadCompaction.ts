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

export const compactForBudget = <T extends Record<string, unknown>>(
  payload: T,
  profiles: ReadonlyArray<CompactionOptions>,
  charBudget: number,
  initialTruncation: ReadonlyArray<TruncationEntry> = [],
): CompactionResult<T> => {
  let finalResult = compactRecord(payload, profiles.at(-1)!, initialTruncation);
  for (const profile of profiles) {
    const result = compactRecord(payload, profile, initialTruncation);
    finalResult = result;
    if (serializedLength(withTruncation(result.value, result.truncation)) <= charBudget) {
      return result;
    }
  }
  return finalResult;
};

/**
 * Generic model-result compaction shared by every copilot family reader. It
 * bounds scalar and collection fan-out without making the copilot depend on a
 * particular owning module's result shape.
 */
export const boundPayload = <T extends Record<string, unknown>>(payload: T): T =>
  compactRecord(payload, { maxStringChars: MAX_STRING_CHARS, maxArrayItems: MAX_ARRAY_ITEMS }).value;
