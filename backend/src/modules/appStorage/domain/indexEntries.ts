import type { BoundedJsonRecord, StorageCollection, StorageFieldType } from "@radioso/app-contract";

/**
 * One declared index's value for one record. Exactly one column carries a value,
 * which is what lets a scalar be compared with its own type's ordering instead
 * of being flattened into text.
 */
export interface AppStorageIndexEntry {
  indexId: string;
  textValue: string | null;
  numericValue: number | null;
  booleanValue: boolean | null;
  timestampValue: Date | null;
}

const emptyEntry = (indexId: string): AppStorageIndexEntry => ({
  indexId,
  textValue: null,
  numericValue: null,
  booleanValue: null,
  timestampValue: null,
});

/** Which value column a declared scalar field type is stored and compared in. */
export type AppStorageIndexColumn = "text_value" | "numeric_value" | "boolean_value" | "timestamp_value";

export const indexColumnForFieldType = (type: StorageFieldType): AppStorageIndexColumn | null => {
  switch (type) {
    case "string":
      return "text_value";
    case "number":
      return "numeric_value";
    case "boolean":
      return "boolean_value";
    case "timestamp":
      return "timestamp_value";
    case "json":
      return null;
  }
};

/**
 * The entry one indexed field of one record produces, or `null` when the record
 * carries nothing the index can compare. A record that omits an indexed optional
 * field produces no entry for it, so a query by that index cannot match a record
 * that never carried the value.
 */
export const buildStorageIndexEntry = (input: {
  indexId: string;
  fieldType: StorageFieldType;
  value: unknown;
}): AppStorageIndexEntry | null => {
  const { indexId, value } = input;

  switch (indexColumnForFieldType(input.fieldType)) {
    case "text_value":
      return typeof value === "string" ? { ...emptyEntry(indexId), textValue: value } : null;
    case "numeric_value":
      return typeof value === "number" && Number.isFinite(value)
        ? { ...emptyEntry(indexId), numericValue: value }
        : null;
    case "boolean_value":
      return typeof value === "boolean" ? { ...emptyEntry(indexId), booleanValue: value } : null;
    case "timestamp_value": {
      if (typeof value !== "string") return null;
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? null : { ...emptyEntry(indexId), timestampValue: parsed };
    }
    default:
      return null;
  }
};

/** Every index row a record produces, in the order the collection declares them. */
export const buildStorageIndexEntries = (
  collection: StorageCollection,
  record: BoundedJsonRecord,
): AppStorageIndexEntry[] => {
  const fieldTypes = new Map(collection.recordSchema.fields.map((field) => [field.key, field.type]));
  const entries: AppStorageIndexEntry[] = [];

  for (const index of collection.indexes) {
    const fieldType = fieldTypes.get(index.field);
    if (fieldType === undefined) continue;
    if (!Object.hasOwn(record, index.field)) continue;

    const entry = buildStorageIndexEntry({ indexId: index.id, fieldType, value: record[index.field] });
    if (entry) entries.push(entry);
  }

  return entries;
};
