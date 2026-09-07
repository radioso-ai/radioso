import {
  boundedJsonValueSchema,
  storageRecordValueSchema,
  timestampSchema,
  type BoundedJsonRecord,
  type StorageCollection,
  type StorageFieldType,
} from "@radioso/app-contract";

type StorageRecordValidation =
  | { ok: true; record: BoundedJsonRecord; byteSize: number }
  | { ok: false; code: "invalid_input" | "quota_exceeded"; message: string };

const matchesFieldType = (type: StorageFieldType, value: unknown): boolean => {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "timestamp":
      return typeof value === "string" && timestampSchema.safeParse(value).success;
    case "json":
      return boundedJsonValueSchema.safeParse(value).success;
  }
};

/**
 * A record is measured against the collection its App declared: the fields that
 * must be there, the types they carry, nothing beyond them, and a serialized
 * size the collection's own quota admits.
 *
 * The bounded-JSON parse runs first. It is what makes the size measurement below
 * safe: after it, the value is known to serialize within the protocol's ceiling,
 * so stringifying it to count bytes cannot be turned into an allocation attack
 * by the record that is about to be refused.
 */
export const validateStorageRecord = (
  collection: StorageCollection,
  value: unknown,
): StorageRecordValidation => {
  const bounded = storageRecordValueSchema.safeParse(value);
  if (!bounded.success) {
    return { ok: false, code: "invalid_input", message: "A record must be a bounded JSON object" };
  }
  const record = bounded.data;

  const declared = new Map(collection.recordSchema.fields.map((field) => [field.key, field]));
  for (const key of Object.keys(record)) {
    if (!declared.has(key)) {
      return {
        ok: false,
        code: "invalid_input",
        message: `Collection ${collection.id} does not declare the field ${key}`,
      };
    }
  }

  for (const field of collection.recordSchema.fields) {
    const present = Object.hasOwn(record, field.key);
    if (!present) {
      if (!field.required) continue;
      return {
        ok: false,
        code: "invalid_input",
        message: `Collection ${collection.id} requires the field ${field.key}`,
      };
    }
    if (!matchesFieldType(field.type, record[field.key])) {
      return {
        ok: false,
        code: "invalid_input",
        message: `Field ${field.key} must carry a ${field.type} value`,
      };
    }
  }

  const byteSize = Buffer.byteLength(JSON.stringify(record), "utf8");
  if (byteSize > collection.quotas.maxRecordBytes) {
    return {
      ok: false,
      code: "quota_exceeded",
      message: `Collection ${collection.id} admits at most ${collection.quotas.maxRecordBytes} bytes per record`,
    };
  }

  return { ok: true, record, byteSize };
};
