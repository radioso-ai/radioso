import { describe, expect, it } from "vitest";

import {
  isScalarStorageFieldType,
  scalarStorageFieldTypes,
  storageCollectionSchema,
  storageDeleteRequestSchema,
  storageFieldTypes,
  storageGetRequestSchema,
  storageOperations,
  storagePutRequestSchema,
  storageQueryRequestSchema,
} from "../src/index.js";

const collection = {
  id: "sync_state",
  scope: "installation",
  schemaVersion: 1,
  compatibleReaderVersions: [1],
  recordSchema: {
    fields: [
      { key: "cursor", type: "string", required: true },
      { key: "updated_at", type: "timestamp", required: true },
    ],
  },
  indexes: [{ id: "by_updated_at", field: "updated_at" }],
  quotas: { maxRecords: 1000, maxRecordBytes: 16384 },
  retention: { kind: "none" },
  allowedOperations: ["get", "put", "delete", "query_by_index"],
};

describe("storage collection declarations", () => {
  it("declares the record field vocabulary and which of it is scalar", () => {
    expect([...storageFieldTypes]).toEqual(["string", "number", "boolean", "timestamp", "json"]);
    expect([...scalarStorageFieldTypes]).toEqual(["string", "number", "boolean", "timestamp"]);
    expect(isScalarStorageFieldType("json")).toBe(false);
    expect(isScalarStorageFieldType("timestamp")).toBe(true);
  });

  it("accepts an installation-scoped collection", () => {
    expect(storageCollectionSchema.parse(collection).id).toBe("sync_state");
  });

  it("rejects a scope other than installation", () => {
    expect(storageCollectionSchema.safeParse({ ...collection, scope: "workspace" }).success).toBe(false);
  });

  it("declares the allowed operation vocabulary and rejects anything outside it", () => {
    expect([...storageOperations]).toEqual(["get", "put", "delete", "query_by_index"]);
    expect(storageCollectionSchema.safeParse({ ...collection, allowedOperations: ["scan"] }).success).toBe(false);
    expect(storageCollectionSchema.safeParse({ ...collection, allowedOperations: [] }).success).toBe(false);
  });

  it("requires positive quotas", () => {
    expect(
      storageCollectionSchema.safeParse({ ...collection, quotas: { maxRecords: 0, maxRecordBytes: 16384 } }).success,
    ).toBe(false);
  });

  it("accepts ttl retention with seconds and rejects ttl without them", () => {
    expect(storageCollectionSchema.parse({ ...collection, retention: { kind: "ttl", seconds: 86400 } })).toMatchObject({
      retention: { kind: "ttl", seconds: 86400 },
    });
    expect(storageCollectionSchema.safeParse({ ...collection, retention: { kind: "ttl" } }).success).toBe(false);
  });

  it("rejects a compatible reader version list that omits the declared schema version", () => {
    expect(
      storageCollectionSchema.safeParse({ ...collection, schemaVersion: 2, compatibleReaderVersions: [1] }).success,
    ).toBe(false);
  });
});

describe("scoped storage operations", () => {
  it("parses get, delete, put, and query requests", () => {
    expect(storageGetRequestSchema.parse({ collection: "sync_state", key: "site" })).toMatchObject({ key: "site" });
    expect(
      storageDeleteRequestSchema.parse({ collection: "sync_state", key: "site", expectedVersion: 3 }),
    ).toMatchObject({ expectedVersion: 3 });
    expect(
      storagePutRequestSchema.parse({
        collection: "sync_state",
        key: "site",
        record: { cursor: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" },
      }),
    ).toMatchObject({ collection: "sync_state" });
    expect(
      storageQueryRequestSchema.parse({
        collection: "sync_state",
        index: "by_updated_at",
        equals: "2026-01-01T00:00:00.000Z",
        limit: 25,
      }),
    ).toMatchObject({ index: "by_updated_at", limit: 25 });
  });

  it("rejects a query whose match value is not a scalar", () => {
    expect(
      storageQueryRequestSchema.safeParse({
        collection: "sync_state",
        index: "by_updated_at",
        equals: { nested: true },
      }).success,
    ).toBe(false);
  });

  it("rejects a non-positive expected version", () => {
    expect(
      storageDeleteRequestSchema.safeParse({ collection: "sync_state", key: "site", expectedVersion: 0 }).success,
    ).toBe(false);
  });
});
