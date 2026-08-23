import { describe, expect, it } from "vitest";

import type { DocumentTypeFieldDefinition } from "../../src/modules/documentTypes/contracts/documentTypeCatalog.js";
import {
  EXTRACTED_TAGS_MAX_BYTES,
  EXTRACTED_VALUE_MAX_CHARS,
  applyExtractedFields,
  validateExtractedFields,
} from "../../src/modules/documents/domain/enrichment/extractedFields.js";
import { parseDocumentEnrichmentOutput } from "../../src/modules/documents/domain/enrichment/documentEnrichmentContract.js";

const declaredFields: DocumentTypeFieldDefinition[] = [
  { key: "productName", label: "Product name", valueType: "string", instruction: "" },
  { key: "price", label: "Price", valueType: "number", instruction: "" },
  { key: "availableFrom", label: "Available from", valueType: "date", instruction: "" },
  { key: "inStock", label: "In stock", valueType: "boolean", instruction: "" },
];

const chunk = (chunkIndex: number, metadata: Record<string, unknown> = {}) => ({
  chunkIndex,
  content: "body",
  startOffset: chunkIndex * 10,
  endOffset: chunkIndex * 10 + 10,
  metadata,
});

describe("enrichment envelope parsing", () => {
  it("reads the type key from the envelope's type field", () => {
    const parsed = parseDocumentEnrichmentOutput({ type: "product", confidence: 0.9, fields: [] });

    expect(parsed.typeKey).toBe("product");
    // An operator type is not a built-in shape, so the temporal lane stays generic.
    expect(parsed.shape).toBe("generic");
  });

  it("still accepts the built-in envelope key", () => {
    const parsed = parseDocumentEnrichmentOutput({ shape: "event", confidence: 0.9, facts: [] });

    expect(parsed.typeKey).toBe("event");
    expect(parsed.shape).toBe("event");
  });

  it("keeps the fields payload as an ordered array so duplicates survive parsing", () => {
    const parsed = parseDocumentEnrichmentOutput({
      type: "product",
      confidence: 0.9,
      fields: [
        { key: "price", value: 10 },
        { key: "price", value: 20 },
      ],
    });

    expect(parsed.fields).toHaveLength(2);
  });

  it("degrades a missing or non-array fields payload to an empty array", () => {
    expect(parseDocumentEnrichmentOutput({ type: "product", confidence: 0.9 }).fields).toEqual([]);
    expect(
      parseDocumentEnrichmentOutput({ type: "product", confidence: 0.9, fields: { price: 10 } }).fields,
    ).toEqual([]);
  });
});

describe("extracted field validation", () => {
  it("applies valid entries in catalog field order", () => {
    const result = validateExtractedFields({
      entries: [
        { key: "price", value: 19.99 },
        { key: "productName", value: "Desk lamp" },
      ],
      declaredFields,
    });

    expect(result.fields).toEqual([
      { key: "productName", value: "Desk lamp" },
      { key: "price", value: 19.99 },
    ]);
    expect(result.counts).toMatchObject({ droppedInvalid: 0, droppedUndeclared: 0, droppedDuplicate: 0, droppedOverCap: 0 });
  });

  it("drops an undeclared key and counts it", () => {
    const result = validateExtractedFields({
      entries: [{ key: "price", value: 10 }, { key: "colour", value: "red" }],
      declaredFields,
    });

    expect(result.fields).toEqual([{ key: "price", value: 10 }]);
    expect(result.counts.droppedUndeclared).toBe(1);
  });

  it("drops values that fail their declared value type and counts them", () => {
    const result = validateExtractedFields({
      entries: [
        { key: "price", value: "not a number" },
        { key: "availableFrom", value: "2026-13-01" },
        { key: "inStock", value: "maybe" },
        { key: "productName", value: "Desk lamp" },
      ],
      declaredFields,
    });

    expect(result.fields).toEqual([{ key: "productName", value: "Desk lamp" }]);
    expect(result.counts.droppedInvalid).toBe(3);
  });

  it("keeps the first of duplicate keys and counts the rest", () => {
    const result = validateExtractedFields({
      entries: [
        { key: "price", value: 10 },
        { key: "price", value: 20 },
        { key: "price", value: 30 },
      ],
      declaredFields,
    });

    expect(result.fields).toEqual([{ key: "price", value: 10 }]);
    expect(result.counts.droppedDuplicate).toBe(2);
  });

  it("drops structurally invalid entries and counts them", () => {
    const result = validateExtractedFields({
      entries: ["price", null, { value: 10 }, { key: 5, value: 10 }, { key: "price", value: null }],
      declaredFields,
    });

    expect(result.fields).toEqual([]);
    expect(result.counts.droppedInvalid).toBe(5);
  });

  it("leaves declared but missing fields simply absent", () => {
    const result = validateExtractedFields({
      entries: [{ key: "price", value: 10 }],
      declaredFields,
    });

    expect(result.fields.map((field) => field.key)).toEqual(["price"]);
    expect(result.counts.droppedInvalid).toBe(0);
  });

  it("coerces numeric and boolean strings the model commonly returns", () => {
    const result = validateExtractedFields({
      entries: [
        { key: "price", value: "19.99" },
        { key: "inStock", value: "true" },
      ],
      declaredFields,
    });

    expect(result.fields).toEqual([
      { key: "price", value: 19.99 },
      { key: "inStock", value: true },
    ]);
  });

  it("drops a string value longer than the per-value cap", () => {
    const result = validateExtractedFields({
      entries: [{ key: "productName", value: "x".repeat(EXTRACTED_VALUE_MAX_CHARS + 1) }],
      declaredFields,
    });

    expect(result.fields).toEqual([]);
    expect(result.counts.droppedOverCap).toBe(1);
  });

  it("drops trailing catalog fields once the serialized tag budget is exceeded", () => {
    const bulkFields: DocumentTypeFieldDefinition[] = Array.from({ length: 60 }, (_unused, index) => ({
      key: `field${String(index).padStart(2, "0")}`,
      label: `Field ${index}`,
      valueType: "string",
      instruction: "",
    }));
    const entries = bulkFields.map((field) => ({ key: field.key, value: "y".repeat(EXTRACTED_VALUE_MAX_CHARS) }));

    const result = validateExtractedFields({ entries, declaredFields: bulkFields });

    const serialized = JSON.stringify(Object.fromEntries(result.fields.map((field) => [field.key, field.value])));
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(EXTRACTED_TAGS_MAX_BYTES);
    expect(result.counts.droppedOverCap).toBeGreaterThan(0);
    // Deterministic drop order: earlier catalog fields survive.
    expect(result.fields[0]?.key).toBe("field00");
  });
});

describe("extracted field ownership", () => {
  it("writes generated tags to the document and every chunk", () => {
    const result = applyExtractedFields({
      documentMetadata: { source: "manual" },
      chunks: [chunk(0), chunk(1)],
      fields: [{ key: "price", value: 10 }],
      previousGeneratedKeys: [],
    });

    expect(result.documentMetadata).toEqual({ source: "manual", price: 10 });
    expect(result.chunks.map((entry) => entry.metadata)).toEqual([{ price: 10 }, { price: 10 }]);
    expect(result.generatedKeys).toEqual(["price"]);
    expect(result.appliedChunkCount).toBe(2);
  });

  it("skips a key it does not own and counts the collision", () => {
    const result = applyExtractedFields({
      documentMetadata: { price: 99 },
      chunks: [chunk(0, { price: 99 })],
      fields: [{ key: "price", value: 10 }],
      previousGeneratedKeys: [],
    });

    expect(result.documentMetadata).toEqual({ price: 99 });
    expect(result.generatedKeys).toEqual([]);
    expect(result.skippedCollision).toBe(1);
  });

  it("replaces a key it generated on the previous run", () => {
    const result = applyExtractedFields({
      documentMetadata: { price: 99 },
      chunks: [chunk(0, { price: 99 })],
      fields: [{ key: "price", value: 10 }],
      previousGeneratedKeys: ["price"],
    });

    expect(result.documentMetadata).toEqual({ price: 10 });
    expect(result.generatedKeys).toEqual(["price"]);
    expect(result.skippedCollision).toBe(0);
  });

  it("removes a previously generated key that the current catalog no longer declares", () => {
    const result = applyExtractedFields({
      documentMetadata: { price: 99, category: "lighting", source: "manual" },
      chunks: [chunk(0, { price: 99, category: "lighting" })],
      fields: [{ key: "price", value: 10 }],
      previousGeneratedKeys: ["price", "category"],
    });

    expect(result.documentMetadata).toEqual({ source: "manual", price: 10 });
    expect(result.chunks[0]?.metadata).toEqual({ price: 10 });
    expect(result.generatedKeys).toEqual(["price"]);
  });

  it("clears every generated tag when the run produces no fields", () => {
    const result = applyExtractedFields({
      documentMetadata: { price: 99, source: "manual" },
      chunks: [chunk(0, { price: 99 })],
      fields: [],
      previousGeneratedKeys: ["price"],
    });

    expect(result.documentMetadata).toEqual({ source: "manual" });
    expect(result.chunks[0]?.metadata).toEqual({});
    expect(result.generatedKeys).toEqual([]);
  });

  it("leaves documents and chunks untouched when there is nothing to write or clean", () => {
    const chunks = [chunk(0, { source: "manual" })];

    const result = applyExtractedFields({
      documentMetadata: { source: "manual" },
      chunks,
      fields: [],
      previousGeneratedKeys: [],
    });

    expect(result.documentMetadata).toEqual({ source: "manual" });
    expect(result.chunks).toBe(chunks);
    expect(result.appliedChunkCount).toBe(0);
  });
});
