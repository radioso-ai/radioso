import type {
  DocumentTypeFieldDefinition,
  DocumentTypeFieldValueType,
} from "../../../documentTypes/contracts/documentTypeCatalog.js";
import type { EnrichableChunk } from "./chunkMetadataPatches.js";

export type ExtractedFieldValue = string | number | boolean;

export interface ExtractedField {
  readonly key: string;
  readonly value: ExtractedFieldValue;
}

export interface ExtractedFieldDropCounts {
  droppedInvalid: number;
  droppedUndeclared: number;
  droppedDuplicate: number;
  droppedOverCap: number;
}

/** A tag long enough to be prose is not a filterable tag; cap and drop rather than truncate. */
export const EXTRACTED_VALUE_MAX_CHARS = 256;

/** Ceiling on the tags one run may add to a document, measured on the serialized map. */
export const EXTRACTED_TAGS_MAX_BYTES = 8 * 1024;

// Shape alone is not enough: a model can emit a well-formed but calendar-invalid
// date such as 2026-02-31, which the stored date columns would later reject.
const isValidIsoCalendarDate = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (Number.isNaN(timestamp)) {
    return false;
  }
  return new Date(timestamp).toISOString().slice(0, 10) === value;
};

/**
 * Coerces a model-supplied value to its declared type, or returns `null` when
 * it cannot be. Numeric and boolean strings are accepted because models emit
 * them routinely; this is JSON-level parsing, not product vocabulary.
 */
const coerceValue = (value: unknown, valueType: DocumentTypeFieldValueType): ExtractedFieldValue | null => {
  if (value === null || value === undefined) {
    return null;
  }
  switch (valueType) {
    case "string": {
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
        return null;
      }
      const text = String(value).trim();
      return text.length > 0 ? text : null;
    }
    case "number": {
      if (typeof value === "number") {
        return Number.isFinite(value) ? value : null;
      }
      if (typeof value !== "string" || value.trim().length === 0) {
        return null;
      }
      const parsed = Number(value.trim());
      return Number.isFinite(parsed) ? parsed : null;
    }
    case "boolean": {
      if (typeof value === "boolean") {
        return value;
      }
      if (typeof value !== "string") {
        return null;
      }
      const normalized = value.trim().toLowerCase();
      if (normalized === "true") {
        return true;
      }
      if (normalized === "false") {
        return false;
      }
      return null;
    }
    case "date": {
      if (typeof value !== "string") {
        return null;
      }
      const normalized = value.trim();
      return isValidIsoCalendarDate(normalized) ? normalized : null;
    }
    default:
      return null;
  }
};

const serializedByteLength = (fields: readonly ExtractedField[]): number =>
  Buffer.byteLength(JSON.stringify(Object.fromEntries(fields.map((field) => [field.key, field.value]))), "utf8");

/**
 * Stage 2 of output validation: every entry is judged independently. No single
 * drop fails the document; each drop is counted so provenance can report it
 * without carrying any document content.
 */
export const validateExtractedFields = (input: {
  entries: readonly unknown[];
  declaredFields: readonly DocumentTypeFieldDefinition[];
}): { fields: ExtractedField[]; counts: ExtractedFieldDropCounts } => {
  const counts: ExtractedFieldDropCounts = {
    droppedInvalid: 0,
    droppedUndeclared: 0,
    droppedDuplicate: 0,
    droppedOverCap: 0,
  };
  const declared = new Map(input.declaredFields.map((field, index) => [field.key, { field, index }]));
  const seenKeys = new Set<string>();
  const accepted: Array<{ field: ExtractedField; index: number }> = [];

  for (const entry of input.entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      counts.droppedInvalid += 1;
      continue;
    }
    const candidate = entry as { key?: unknown; value?: unknown };
    if (typeof candidate.key !== "string" || candidate.key.length === 0) {
      counts.droppedInvalid += 1;
      continue;
    }
    const declaration = declared.get(candidate.key);
    if (!declaration) {
      counts.droppedUndeclared += 1;
      continue;
    }
    // The model has spoken for this key; later entries are duplicates whatever
    // their value, so "first occurrence wins" stays deterministic.
    if (seenKeys.has(candidate.key)) {
      counts.droppedDuplicate += 1;
      continue;
    }
    seenKeys.add(candidate.key);

    const coerced = coerceValue(candidate.value, declaration.field.valueType);
    if (coerced === null) {
      counts.droppedInvalid += 1;
      continue;
    }
    if (typeof coerced === "string" && coerced.length > EXTRACTED_VALUE_MAX_CHARS) {
      counts.droppedOverCap += 1;
      continue;
    }
    accepted.push({ field: { key: candidate.key, value: coerced }, index: declaration.index });
  }

  // Catalog field order makes the total-size drop deterministic: earlier
  // declarations survive, later ones are shed.
  accepted.sort((left, right) => left.index - right.index);
  const fields: ExtractedField[] = [];
  let overBudget = false;
  for (const { field } of accepted) {
    if (overBudget) {
      counts.droppedOverCap += 1;
      continue;
    }
    const next = [...fields, field];
    if (serializedByteLength(next) > EXTRACTED_TAGS_MAX_BYTES) {
      overBudget = true;
      counts.droppedOverCap += 1;
      continue;
    }
    fields.push(field);
  }

  return { fields, counts };
};

const omitKeys = (
  metadata: Record<string, unknown>,
  keys: ReadonlySet<string>,
): Record<string, unknown> => {
  if (keys.size === 0) {
    return metadata;
  }
  return Object.fromEntries(Object.entries(metadata).filter(([key]) => !keys.has(key)));
};

/**
 * Applies validated fields under the ownership rule: extraction owns exactly
 * the keys it generated for this document. The previous run's keys are removed
 * first, so a key still present afterwards is manually authored or
 * connector-supplied and is left alone.
 */
export const applyExtractedFields = <TChunk extends EnrichableChunk>(input: {
  documentMetadata: Record<string, unknown>;
  chunks: TChunk[];
  fields: readonly ExtractedField[];
  previousGeneratedKeys: readonly string[];
}): {
  documentMetadata: Record<string, unknown>;
  chunks: TChunk[];
  generatedKeys: string[];
  skippedCollision: number;
  appliedChunkCount: number;
} => {
  const owned = new Set(input.previousGeneratedKeys);
  const base = omitKeys(input.documentMetadata, owned);

  const generated: Record<string, ExtractedFieldValue> = {};
  let skippedCollision = 0;
  for (const field of input.fields) {
    if (Object.prototype.hasOwnProperty.call(base, field.key)) {
      skippedCollision += 1;
      continue;
    }
    generated[field.key] = field.value;
  }
  const generatedKeys = Object.keys(generated);

  if (owned.size === 0 && generatedKeys.length === 0) {
    return {
      documentMetadata: input.documentMetadata,
      chunks: input.chunks,
      generatedKeys,
      skippedCollision,
      appliedChunkCount: 0,
    };
  }

  // Document-level scalars propagate to every chunk, the same model the
  // built-in article shape uses.
  const chunks = input.chunks.map((chunk) => ({
    ...chunk,
    metadata: { ...omitKeys(chunk.metadata ?? {}, owned), ...generated },
  }));

  return {
    documentMetadata: { ...base, ...generated },
    chunks,
    generatedKeys,
    skippedCollision,
    appliedChunkCount: generatedKeys.length > 0 ? chunks.length : 0,
  };
};
