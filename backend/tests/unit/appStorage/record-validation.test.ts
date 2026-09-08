import { describe, expect, it } from "vitest";

import { buildStorageCollection } from "../../support/appStorageCollections.js";
import {
  buildStorageIndexEntries,
  INDEXED_STRING_BYTE_BOUND,
  INDEXED_STRING_CHARACTER_BOUND,
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

  it("bounds an indexed string to what a query can ask for", () => {
    // storage.query compares against a bounded scalar, so a longer stored value
    // is one no query could ever match — the collection would hold a record its
    // own declared index cannot find.
    const wide = buildStorageCollection({ quotas: { maxRecords: 10, maxRecordBytes: 65_536 } });
    expect(
      validateStorageRecord(wide, { external_id: "x".repeat(INDEXED_STRING_CHARACTER_BOUND) }),
    ).toMatchObject({ ok: true });
    expect(
      validateStorageRecord(wide, { external_id: "x".repeat(INDEXED_STRING_CHARACTER_BOUND + 1) }),
    ).toMatchObject({ ok: false, code: "invalid_input" });
  });

  it("bounds an indexed string by bytes too, so a valid put cannot fail inside the index write", () => {
    const wide = buildStorageCollection({ quotas: { maxRecords: 10, maxRecordBytes: 65_536 } });
    // Four bytes per character, so the byte ceiling binds well before the
    // character one and a B-tree tuple can still hold the entry.
    const wide4 = "\u{1F600}".repeat(INDEXED_STRING_BYTE_BOUND / 4 + 1);
    expect(validateStorageRecord(wide, { external_id: wide4 })).toMatchObject({
      ok: false,
      code: "invalid_input",
    });
  });

  it("leaves an unindexed string unbounded beyond the collection's own byte quota", () => {
    const wide = buildStorageCollection({ quotas: { maxRecords: 10, maxRecordBytes: 65_536 } });
    const long = "x".repeat(INDEXED_STRING_CHARACTER_BOUND + 1);
    expect(
      validateStorageRecord(wide, { external_id: "post-1", payload: { note: long } }),
    ).toMatchObject({ ok: true });
  });

  it("never repeats a record key, an undeclared field name, or a stored value in its message", () => {
    const undeclared = validateStorageRecord(collection, {
      external_id: "secret-value",
      customer_ssn: 1,
    });
    expect(undeclared.ok).toBe(false);
    if (undeclared.ok) return;
    expect(undeclared.message).not.toContain("secret-value");
    expect(undeclared.message).not.toContain("customer_ssn");

    const mistyped = validateStorageRecord(collection, { external_id: { name: "secret-value" } });
    expect(mistyped.ok).toBe(false);
    if (mistyped.ok) return;
    expect(mistyped.message).not.toContain("secret-value");
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
