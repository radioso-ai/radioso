import { describe, expect, it } from "vitest";

import {
  documentMetadataRecordSchema,
  documentSchema,
  documentRetrievalUpdateSchema,
  sourceUpdateSchema,
} from "../../src/app/http/routes/documentRouteSchemas.js";

// The scalar-record + 16 KB shape is shared by inline documents, imported
// documents, the retrieval PATCH, and source-level document tags. These tests
// pin the shape once so the surfaces cannot drift apart.
describe("document metadata record schema", () => {
  it("accepts flat scalar values", () => {
    const parsed = documentMetadataRecordSchema.parse({
      audience: "operators",
      revision: 3,
      published: true,
      retiredAt: null,
    });

    expect(parsed).toEqual({
      audience: "operators",
      revision: 3,
      published: true,
      retiredAt: null,
    });
  });

  it("accepts an empty record", () => {
    expect(documentMetadataRecordSchema.parse({})).toEqual({});
  });

  it("rejects nested objects", () => {
    expect(documentMetadataRecordSchema.safeParse({ owner: { team: "support" } }).success).toBe(false);
  });

  it("rejects array values", () => {
    expect(documentMetadataRecordSchema.safeParse({ tags: ["a", "b"] }).success).toBe(false);
  });

  it("rejects a record larger than 16 KB", () => {
    const oversized = { blob: "x".repeat(17000) };
    const result = documentMetadataRecordSchema.safeParse(oversized);

    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toContain("16 KB");
  });

  it("accepts a record just under the 16 KB ceiling", () => {
    // 16384 bytes is the ceiling; `{"blob":"..."}` adds 11 bytes of framing.
    const payload = { blob: "x".repeat(16384 - 11) };
    expect(Buffer.byteLength(JSON.stringify(payload), "utf8")).toBe(16384);
    expect(documentMetadataRecordSchema.safeParse(payload).success).toBe(true);
  });

  it("is the same shape the inline document schema enforces", () => {
    expect(documentSchema.safeParse({
      title: "Doc",
      content: "body",
      metadata: { nested: { nope: true } },
    }).success).toBe(false);
    expect(documentSchema.safeParse({
      title: "Doc",
      content: "body",
      metadata: { audience: "operators" },
    }).success).toBe(true);
  });
});

describe("document retrieval update schema", () => {
  it("accepts metadata on its own", () => {
    const parsed = documentRetrievalUpdateSchema.parse({ metadata: { audience: "operators" } });
    expect(parsed).toEqual({ metadata: { audience: "operators" } });
  });

  it("accepts metadata alongside retrieval fields", () => {
    expect(documentRetrievalUpdateSchema.safeParse({
      retrievalEnabled: false,
      metadata: { audience: "operators" },
    }).success).toBe(true);
  });

  it("accepts an empty metadata record so operators can clear every tag", () => {
    expect(documentRetrievalUpdateSchema.safeParse({ metadata: {} }).success).toBe(true);
  });

  it("rejects nested metadata", () => {
    expect(documentRetrievalUpdateSchema.safeParse({ metadata: { owner: { team: "x" } } }).success).toBe(false);
  });

  it("still rejects a body with no fields at all", () => {
    expect(documentRetrievalUpdateSchema.safeParse({}).success).toBe(false);
  });
});

describe("source update schema", () => {
  it("accepts documentMetadata on its own", () => {
    const parsed = sourceUpdateSchema.parse({ documentMetadata: { region: "eu", tier: 2 } });
    expect(parsed).toMatchObject({ documentMetadata: { region: "eu", tier: 2 } });
  });

  it("accepts an empty documentMetadata record so operators can clear source tags", () => {
    expect(sourceUpdateSchema.safeParse({ documentMetadata: {} }).success).toBe(true);
  });

  it("rejects nested documentMetadata", () => {
    expect(sourceUpdateSchema.safeParse({ documentMetadata: { owner: { team: "x" } } }).success).toBe(false);
  });

  it("rejects documentMetadata larger than 16 KB", () => {
    expect(sourceUpdateSchema.safeParse({ documentMetadata: { blob: "x".repeat(17000) } }).success).toBe(false);
  });

  it("still rejects a body with no fields at all", () => {
    expect(sourceUpdateSchema.safeParse({}).success).toBe(false);
  });
});
