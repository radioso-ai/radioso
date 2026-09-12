import { storageCollectionSchema, type StorageCollection } from "@radioso/app-contract";

/**
 * A declared collection shaped like the one the reference App keeps its sync
 * state in: a required scalar the App queries by, an optional scalar, an
 * optional JSON blob, and one declared index.
 */
export const buildStorageCollection = (
  overrides: Partial<StorageCollection> = {},
): StorageCollection =>
  storageCollectionSchema.parse({
    id: "sync_state",
    scope: "installation",
    schemaVersion: 1,
    compatibleReaderVersions: [1],
    recordSchema: {
      fields: [
        { key: "external_id", type: "string", required: true },
        { key: "sequence", type: "number", required: false },
        { key: "published", type: "boolean", required: false },
        { key: "modified_at", type: "timestamp", required: false },
        { key: "payload", type: "json", required: false },
      ],
    },
    indexes: [{ id: "by_external_id", field: "external_id" }],
    quotas: { maxRecords: 100, maxRecordBytes: 4096 },
    retention: { kind: "none" },
    allowedOperations: ["get", "put", "delete", "query_by_index"],
    ...overrides,
  });
