import { describe, expect, it } from "vitest";

import { buildStorageCollection } from "../../support/appStorageCollections.js";
import { resolveStorageQuery } from "../../../src/modules/appStorage/public.js";

describe("resolveStorageQuery", () => {
  const collection = buildStorageCollection();

  it("resolves an equality query on a declared index", () => {
    const result = resolveStorageQuery(collection, {
      collection: "sync_state",
      index: "by_external_id",
      equals: "post-1",
      limit: 25,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      indexId: "by_external_id",
      limit: 25,
      cursor: null,
      equals: { column: "text_value", value: "post-1" },
    });
  });

  it("rejects an index the collection does not declare", () => {
    const result = resolveStorageQuery(collection, {
      collection: "sync_state",
      index: "by_secret",
      equals: "post-1",
      limit: 25,
    });
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });

  it("rejects a comparison value whose type is not the indexed field's type", () => {
    const result = resolveStorageQuery(collection, {
      collection: "sync_state",
      index: "by_external_id",
      equals: 7,
      limit: 25,
    });
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });

  it("routes each scalar type to its own value column", () => {
    const wide = buildStorageCollection({
      indexes: [
        { id: "by_sequence", field: "sequence" },
        { id: "by_published", field: "published" },
        { id: "by_modified", field: "modified_at" },
      ],
    });

    expect(
      resolveStorageQuery(wide, { collection: "sync_state", index: "by_sequence", equals: 12, limit: 10 }),
    ).toMatchObject({ ok: true, value: { equals: { column: "numeric_value", value: 12 } } });
    expect(
      resolveStorageQuery(wide, { collection: "sync_state", index: "by_published", equals: true, limit: 10 }),
    ).toMatchObject({ ok: true, value: { equals: { column: "boolean_value", value: true } } });
    expect(
      resolveStorageQuery(wide, {
        collection: "sync_state",
        index: "by_modified",
        equals: "2026-09-07T10:00:00.000Z",
        limit: 10,
      }),
    ).toMatchObject({ ok: true, value: { equals: { column: "timestamp_value" } } });
  });

  it("rejects a query against a collection that does not allow query_by_index", () => {
    const readOnly = buildStorageCollection({ allowedOperations: ["get", "put"] });
    expect(
      resolveStorageQuery(readOnly, {
        collection: "sync_state",
        index: "by_external_id",
        equals: "post-1",
        limit: 10,
      }),
    ).toMatchObject({ ok: false, error: { code: "denied" } });
  });

  it("carries an opaque cursor through as the record key a page resumes after", () => {
    const result = resolveStorageQuery(collection, {
      collection: "sync_state",
      index: "by_external_id",
      equals: "post-1",
      limit: 10,
      cursor: "post-9",
    });
    expect(result).toMatchObject({ ok: true, value: { cursor: "post-9" } });
  });
});
