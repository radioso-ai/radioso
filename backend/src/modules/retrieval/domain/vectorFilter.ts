import type { RetrievalSourceFilter } from "./retrievalSourceFilter.js";

export type VectorMetadataFilterValue =
  | string
  | number
  | boolean
  | null
  | VectorMetadataFilterValue[]
  | { [key: string]: VectorMetadataFilterValue };

/**
 * Backend-neutral metadata containment filter.
 *
 * A chunk matches when its metadata contains every top-level key in this object
 * and each supplied value matches the stored JSON value for that key. Nested
 * objects apply the same containment rule recursively. Arrays are treated as
 * JSON values whose matching behavior must be documented by each adapter before
 * callers rely on array-specific semantics.
 */
export type VectorMetadataFilter = Record<string, VectorMetadataFilterValue>;

export interface VectorChunkFilter {
  metadataContains?: VectorMetadataFilter;
  source?: RetrievalSourceFilter;
}

export const normalizeVectorMetadataFilter = (
  input?: Record<string, unknown>,
): VectorMetadataFilter | undefined => {
  if (!input || Object.keys(input).length === 0) {
    return undefined;
  }

  for (const [key, value] of Object.entries(input)) {
    if (!isVectorMetadataFilterValue(value)) {
      throw new Error(`Unsupported metadata filter value for key "${key}"`);
    }
  }

  return input as VectorMetadataFilter;
};

export const hasVectorMetadataFilter = (
  filter?: VectorMetadataFilter,
): filter is VectorMetadataFilter => filter !== undefined && Object.keys(filter).length > 0;

export const mergeVectorMetadataFilters = (
  modelFilter?: Record<string, unknown>,
  callerFilter?: Record<string, unknown>,
): VectorMetadataFilter | undefined => {
  const normalizedModel = normalizeVectorMetadataFilter(modelFilter);
  const normalizedCaller = normalizeVectorMetadataFilter(callerFilter);
  if (!normalizedModel && !normalizedCaller) {
    return undefined;
  }
  if (!normalizedModel) {
    return normalizedCaller;
  }
  if (!normalizedCaller) {
    return normalizedModel;
  }

  return mergeFilterRecords(normalizedModel, normalizedCaller);
};

const isVectorMetadataFilterValue = (value: unknown): value is VectorMetadataFilterValue => {
  if (value === null) {
    return true;
  }

  const valueType = typeof value;
  if (valueType === "string" || valueType === "boolean") {
    return true;
  }

  if (valueType === "number") {
    return Number.isFinite(value);
  }

  if (Array.isArray(value)) {
    return value.every(isVectorMetadataFilterValue);
  }

  if (valueType === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.values(value as Record<string, unknown>).every(isVectorMetadataFilterValue);
  }

  return false;
};

const mergeFilterRecords = (
  modelFilter: VectorMetadataFilter,
  callerFilter: VectorMetadataFilter,
): VectorMetadataFilter => {
  const merged: VectorMetadataFilter = { ...modelFilter };

  for (const [key, callerValue] of Object.entries(callerFilter)) {
    const modelValue = merged[key];
    if (isPlainFilterObject(modelValue) && isPlainFilterObject(callerValue)) {
      merged[key] = mergeFilterRecords(modelValue, callerValue);
      continue;
    }
    merged[key] = callerValue;
  }

  return merged;
};

const isPlainFilterObject = (value: VectorMetadataFilterValue | undefined): value is VectorMetadataFilter =>
  value !== null && typeof value === "object" && !Array.isArray(value);
