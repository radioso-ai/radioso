import { describe, expect, it } from "vitest";

import { buildStorageCollection } from "../../support/appStorageCollections.js";
import {
  buildStorageIndexEntries,
  validateStorageRecord,
} from "../../../src/modules/appStorage/public.js";

describe("validateStorageRecord", () => {
  const collection = buildStorageCollection();

  it("accepts a record carrying the declared fields and reports its serialized size", () => {
    const result = validateStorageRecord(collection, {
      external_id: "post-1",
      sequence: 12,
      published: true,
      modified_at: "2026-09-07T10:00:00.000Z",
      payload: { title: "hello" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.byteSize).toBeGreaterThan(0);
    expect(result.byteSize).toBeLessThanOrEqual(collection.quotas.maxRecordBytes);
  });

  it("accepts a record that omits every optional field", () => {
    expect(validateStorageRecord(collection, { external_id: "post-1" }).ok).toBe(true);
  });

  it("rejects a record missing a required field", () => {
    const result = validateStorageRecord(collection, { sequence: 1 });
    expect(result).toMatchObject({ ok: false, code: "invalid_input" });
  });

  it("rejects a field whose value does not match its declared type", () => {
    expect(validateStorageRecord(collection, { external_id: 7 })).toMatchObject({
      ok: false,
      code: "invalid_input",
    });
    expect(
      validateStorageRecord(collection, { external_id: "post-1", sequence: "12" }),
    ).toMatchObject({ ok: false, code: "invalid_input" });
    expect(
      validateStorageRecord(collection, { external_id: "post-1", published: "yes" }),
    ).toMatchObject({ ok: false, code: "invalid_input" });
    expect(
      validateStorageRecord(collection, { external_id: "post-1", modified_at: "last tuesday" }),
    ).toMatchObject({ ok: false, code: "invalid_input" });
  });

  it("rejects a field the collection does not declare", () => {
    expect(
      validateStorageRecord(collection, { external_id: "post-1", smuggled: "value" }),
    ).toMatchObject({ ok: false, code: "invalid_input" });
  });

  it("rejects a value that is not a JSON object", () => {
    expect(validateStorageRecord(collection, ["external_id"])).toMatchObject({
      ok: false,
      code: "invalid_input",
    });
    expect(validateStorageRecord(collection, null)).toMatchObject({ ok: false, code: "invalid_input" });
  });

  it("rejects a record serializing past the collection's per-record ceiling", () => {
    const small = buildStorageCollection({ quotas: { maxRecords: 10, maxRecordBytes: 64 } });
    const result = validateStorageRecord(small, {
      external_id: "post-1",
      payload: { note: "x".repeat(512) },
    });
    expect(result).toMatchObject({ ok: false, code: "quota_exceeded" });
  });

  it("never repeats a record key or a stored value in its message", () => {
    const result = validateStorageRecord(collection, { external_id: "secret-value", extra: 1 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).not.toContain("secret-value");
  });
});

describe("buildStorageIndexEntries", () => {
  it("emits one entry per declared index whose field the record carries", () => {
    const collection = buildStorageCollection({
      indexes: [
        { id: "by_external_id", field: "external_id" },
        { id: "by_sequence", field: "sequence" },
        { id: "by_published", field: "published" },
        { id: "by_modified", field: "modified_at" },
      ],
    });

    const entries = buildStorageIndexEntries(collection, {
      external_id: "post-1",
      sequence: 12,
      published: false,
      modified_at: "2026-09-07T10:00:00.000Z",
    });

    expect(entries).toHaveLength(4);
    expect(entries).toContainEqual({
      indexId: "by_external_id",
      textValue: "post-1",
      numericValue: null,
      booleanValue: null,
      timestampValue: null,
    });
    expect(entries.find((entry) => entry.indexId === "by_sequence")?.numericValue).toBe(12);
    expect(entries.find((entry) => entry.indexId === "by_published")?.booleanValue).toBe(false);
    expect(entries.find((entry) => entry.indexId === "by_modified")?.timestampValue).toEqual(
      new Date("2026-09-07T10:00:00.000Z"),
    );
  });

  it("skips an index whose field the record omits", () => {
    const collection = buildStorageCollection({
      indexes: [
        { id: "by_external_id", field: "external_id" },
        { id: "by_sequence", field: "sequence" },
      ],
    });
    const entries = buildStorageIndexEntries(collection, { external_id: "post-1" });
    expect(entries.map((entry) => entry.indexId)).toEqual(["by_external_id"]);
  });
});
