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
 * The index rows a record produces. A record that omits an indexed optional
 * field produces no entry for it, so a query by that index cannot match a record
 * that never carried the value.
 */
export const buildStorageIndexEntries = (
  collection: StorageCollection,
  record: BoundedJsonRecord,
): AppStorageIndexEntry[] => {
  const fieldTypes = new Map(collection.recordSchema.fields.map((field) => [field.key, field.type]));
  const entries: AppStorageIndexEntry[] = [];

  for (const index of collection.indexes) {
    const type = fieldTypes.get(index.field);
    if (type === undefined) continue;
    if (!Object.hasOwn(record, index.field)) continue;
    const value = record[index.field];

    switch (indexColumnForFieldType(type)) {
      case "text_value":
        if (typeof value === "string") entries.push({ ...emptyEntry(index.id), textValue: value });
        break;
      case "numeric_value":
        if (typeof value === "number" && Number.isFinite(value)) {
          entries.push({ ...emptyEntry(index.id), numericValue: value });
        }
        break;
      case "boolean_value":
        if (typeof value === "boolean") entries.push({ ...emptyEntry(index.id), booleanValue: value });
        break;
      case "timestamp_value":
        if (typeof value === "string") {
          const parsed = new Date(value);
          if (!Number.isNaN(parsed.getTime())) {
            entries.push({ ...emptyEntry(index.id), timestampValue: parsed });
          }
        }
        break;
      default:
        break;
    }
  }

  return entries;
};
