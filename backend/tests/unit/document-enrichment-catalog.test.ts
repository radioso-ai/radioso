import { describe, expect, it, vi } from "vitest";

import type {
  DocumentTypeDefinition,
  EnabledDocumentTypesSnapshot,
} from "../../src/modules/documentTypes/contracts/documentTypeCatalog.js";
import { builtInDocumentTypes } from "../../src/modules/documentTypes/domain/builtInDocumentTypes.js";
import { createDefaultDocumentEnrichmentStrategyRegistry } from "../../src/modules/documents/domain/enrichment/enrichmentStrategies.js";
import type { DocumentEnrichmentProvenance } from "../../src/modules/documents/domain/enrichment/documentEnrichmentContract.js";
import { DocumentEnrichmentService } from "../../src/modules/documents/services/documentEnrichmentService.js";

const productType: DocumentTypeDefinition = {
  key: "product",
  label: "Product",
  description: "A product detail page listing a purchasable item.",
  enabled: true,
  origin: "operator",
  payload: "fields",
  disableable: true,
  fields: [
    { key: "productName", label: "Product name", valueType: "string", instruction: "The product's display name." },
    { key: "price", label: "Price", valueType: "number", instruction: "The listed price as a number." },
    { key: "category", label: "Category", valueType: "string", instruction: "The product's category." },
  ],
};

const catalog = (
  types: DocumentTypeDefinition[] = [productType],
  revision = "4",
): EnabledDocumentTypesSnapshot => ({
  revision,
  types: [...builtInDocumentTypes.map((type) => ({ ...type })), ...types],
});

const serviceWith = (output: unknown) =>
  new DocumentEnrichmentService({
    gateway: { generate: vi.fn().mockResolvedValue({ model: "gpt-5.2", output }) },
    strategyRegistry: createDefaultDocumentEnrichmentStrategyRegistry(),
    now: () => new Date("2026-08-21T12:00:00.000Z"),
  });

const enrichInput = (overrides: {
  metadata?: Record<string, unknown>;
  chunkMetadata?: Record<string, unknown>;
  catalog?: EnabledDocumentTypesSnapshot;
  previousProvenance?: DocumentEnrichmentProvenance | null;
} = {}) => ({
  document: {
    id: "doc-1",
    workspaceId: "workspace-1",
    revision: 3,
    title: "Desk lamp",
    markdownContent: "Desk lamp\n\nA warm LED desk lamp priced at 19.99 EUR.",
    metadata: overrides.metadata ?? {},
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
  },
  chunks: [
    {
      chunkIndex: 0,
      content: "Desk lamp\n\nA warm LED desk lamp priced at 19.99 EUR.",
      startOffset: 0,
      endOffset: 51,
      metadata: overrides.chunkMetadata ?? {},
    },
  ],
  anchor: { source: "document_created_at" as const, date: "2026-08-01" },
  catalog: overrides.catalog ?? catalog(),
  previousProvenance: overrides.previousProvenance ?? null,
});

describe("schema-driven enrichment", () => {
  it("applies an operator type's fields to the document and its chunks", async () => {
    const service = serviceWith({
      type: "product",
      confidence: 0.94,
      fields: [
        { key: "productName", value: "Desk lamp" },
        { key: "price", value: 19.99 },
      ],
    });

    const result = await service.enrich(enrichInput());

    expect(result.status).toBe("applied");
    expect(result.documentMetadata).toEqual({ productName: "Desk lamp", price: 19.99 });
    expect(result.chunks[0]?.metadata).toEqual({ productName: "Desk lamp", price: 19.99 });
    expect(result.provenance).toMatchObject({
      status: "applied",
      matchedTypeKey: "product",
      catalogRevision: "4",
      generatedKeys: ["productName", "price"],
    });
    expect(result.provenance.fieldCounts).toMatchObject({
      applied: 2,
      droppedInvalid: 0,
      droppedUndeclared: 0,
      droppedDuplicate: 0,
      droppedOverCap: 0,
      skippedCollision: 0,
    });
  });

  it("counts per-entry drops without failing the document", async () => {
    const service = serviceWith({
      type: "product",
      confidence: 0.94,
      fields: [
        { key: "productName", value: "Desk lamp" },
        { key: "price", value: "not a number" },
        { key: "colour", value: "warm white" },
        { key: "productName", value: "Desk lamp again" },
      ],
    });

    const result = await service.enrich(enrichInput());

    expect(result.status).toBe("applied");
    expect(result.documentMetadata).toEqual({ productName: "Desk lamp" });
    expect(result.provenance.fieldCounts).toMatchObject({
      applied: 1,
      droppedInvalid: 1,
      droppedUndeclared: 1,
      droppedDuplicate: 1,
    });
  });

  it("falls back to generic with no fields when the model names an unknown type", async () => {
    const service = serviceWith({ type: "invoice", confidence: 0.98, fields: [{ key: "price", value: 12 }] });

    const result = await service.enrich(enrichInput());

    expect(result.status).toBe("applied");
    expect(result.provenance).toMatchObject({ shape: "generic", matchedTypeKey: "generic" });
    expect(result.provenance.classificationNote).toBe("unknown_type");
    expect(result.provenance.failureReason).toBeNull();
    expect(result.documentMetadata).toEqual({});
  });

  it("preserves a manually authored value and counts the collision", async () => {
    const service = serviceWith({
      type: "product",
      confidence: 0.94,
      fields: [
        { key: "price", value: 19.99 },
        { key: "productName", value: "Desk lamp" },
      ],
    });

    const result = await service.enrich(enrichInput({ metadata: { price: 9.5 } }));

    expect(result.documentMetadata).toMatchObject({ price: 9.5, productName: "Desk lamp" });
    expect(result.provenance.generatedKeys).toEqual(["productName"]);
    expect(result.provenance.fieldCounts).toMatchObject({ applied: 1, skippedCollision: 1 });
  });

  it("removes a generated key the current catalog no longer declares", async () => {
    const withoutCategory: DocumentTypeDefinition = {
      ...productType,
      fields: productType.fields.filter((field) => field.key !== "category"),
    };
    const service = serviceWith({
      type: "product",
      confidence: 0.94,
      fields: [{ key: "price", value: 19.99 }],
    });

    const result = await service.enrich(
      enrichInput({
        metadata: { price: 9.5, category: "lighting" },
        chunkMetadata: { price: 9.5, category: "lighting" },
        catalog: catalog([withoutCategory], "5"),
        previousProvenance: {
          status: "applied",
          matchedTypeKey: "product",
          catalogRevision: "4",
          generatedKeys: ["price", "category"],
        },
      }),
    );

    expect(result.documentMetadata).toEqual({ price: 19.99 });
    expect(result.chunks[0]?.metadata).toEqual({ price: 19.99 });
    expect(result.provenance).toMatchObject({ generatedKeys: ["price"], catalogRevision: "5" });
  });

  it("leaves tags and the generated-key set intact when the run fails", async () => {
    const service = new DocumentEnrichmentService({
      gateway: { generate: vi.fn().mockRejectedValue(new Error("provider exploded")) },
      strategyRegistry: createDefaultDocumentEnrichmentStrategyRegistry(),
      now: () => new Date("2026-08-21T12:00:00.000Z"),
    });

    const previousProvenance: DocumentEnrichmentProvenance = {
      status: "applied",
      matchedTypeKey: "product",
      catalogRevision: "4",
      generatedKeys: ["price"],
    };

    const result = await service.enrich(
      enrichInput({
        metadata: { price: 19.99, dateFrom: "2026-08-01" },
        chunkMetadata: { price: 19.99 },
        previousProvenance,
      }),
    );

    expect(result.status).toBe("failed");
    expect(result.documentMetadata).toEqual({ price: 19.99, dateFrom: "2026-08-01" });
    expect(result.chunks[0]?.metadata).toEqual({ price: 19.99 });
    expect(result.provenance).toMatchObject({
      status: "failed",
      failureReason: "provider_error",
      generatedKeys: ["price"],
      catalogRevision: "4",
      matchedTypeKey: "product",
    });
  });

  it("fails content-free when the persisted catalog drifts past the prompt budget", async () => {
    const oversized: DocumentTypeDefinition = { ...productType, description: "d".repeat(13_000) };
    const service = serviceWith({ type: "product", confidence: 0.9, fields: [] });

    const result = await service.enrich(enrichInput({ catalog: catalog([oversized]) }));

    expect(result.status).toBe("failed");
    expect(result.provenance.failureReason).toBe("catalog_over_budget");
  });

  it("keeps built-in temporal behavior when no operator type matches", async () => {
    const service = new DocumentEnrichmentService({
      gateway: {
        generate: vi.fn().mockImplementation(({ documentRepresentation }: { documentRepresentation: string }) => {
          const bodyStart = documentRepresentation.indexOf("Desk lamp\n\nA warm");
          return Promise.resolve({
            model: "gpt-5.2",
            output: {
              type: "article",
              confidence: 0.9,
              facts: [
                {
                  id: "published",
                  kind: "article_date",
                  label: "published",
                  dateFrom: "2026-08-02",
                  sourceRange: { start: bodyStart, end: bodyStart + 9 },
                },
              ],
            },
          });
        }),
      },
      strategyRegistry: createDefaultDocumentEnrichmentStrategyRegistry(),
      now: () => new Date("2026-08-21T12:00:00.000Z"),
    });

    const result = await service.enrich(enrichInput());

    expect(result.documentMetadata).toMatchObject({ dateFrom: "2026-08-02", dateTo: "2026-08-02" });
    expect(result.provenance).toMatchObject({ shape: "article", matchedTypeKey: "article" });
    expect(result.provenance.generatedKeys).toEqual([]);
  });
});
