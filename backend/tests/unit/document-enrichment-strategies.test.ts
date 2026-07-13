import { describe, expect, it } from "vitest";

import {
  applyMetadataPatches,
  buildChunkMetadataPatches,
} from "../../src/modules/documents/domain/enrichment/chunkMetadataPatches.js";
import { createDefaultDocumentEnrichmentStrategyRegistry } from "../../src/modules/documents/domain/enrichment/enrichmentStrategies.js";

describe("document enrichment strategies", () => {
  it("applies event date metadata to every overlapping chunk", () => {
    const chunks = [
      { chunkIndex: 0, startOffset: 0, endOffset: 60, metadata: { source: "fixture" } },
      { chunkIndex: 1, startOffset: 61, endOffset: 120, metadata: { source: "fixture" } },
      { chunkIndex: 2, startOffset: 121, endOffset: 180, metadata: { source: "fixture" } },
    ];

    const patches = buildChunkMetadataPatches(chunks, [
      {
        id: "retreat",
        label: "retreat",
        dateFrom: "2026-08-01",
        dateTo: "2026-08-03",
        sourceRange: { start: 40, end: 135 },
      },
    ]);

    const patched = applyMetadataPatches(chunks, patches);

    expect(patched[0]?.metadata).toMatchObject({ dateFrom: "2026-08-01", dateTo: "2026-08-03" });
    expect(patched[1]?.metadata).toMatchObject({ dateFrom: "2026-08-01", dateTo: "2026-08-03" });
    expect(patched[2]?.metadata).toMatchObject({ dateFrom: "2026-08-01", dateTo: "2026-08-03" });
  });

  it("writes the overall event span into document metadata as editable flat tags", () => {
    const registry = createDefaultDocumentEnrichmentStrategyRegistry();
    const result = registry.get("event").apply({
      documentMetadata: { sourceUrl: "https://events.example" },
      chunks: [
        { chunkIndex: 0, startOffset: 0, endOffset: 50, metadata: {} },
      ],
      facts: [
        { id: "f1", kind: "event_date", label: "opening", dateFrom: "2026-07-03", dateTo: "2026-07-03", sourceRange: { start: 0, end: 10 } },
        { id: "f2", kind: "event_date", label: "closing", dateFrom: "2026-07-05", sourceRange: { start: 20, end: 30 } },
      ],
    });

    expect(result.documentMetadata).toEqual({
      sourceUrl: "https://events.example",
      dateFrom: "2026-07-03",
      dateTo: "2026-07-05",
    });
  });

  it("attaches article publication dates at document level and leaves profile/generic temporal facts empty", () => {
    const registry = createDefaultDocumentEnrichmentStrategyRegistry();
    const article = registry.get("article").apply({
      documentMetadata: {},
      chunks: [],
      facts: [
        {
          id: "published",
          kind: "article_date",
          label: "published",
          dateFrom: "2026-06-01",
          dateTo: "2026-06-01",
          sourceRange: { start: 0, end: 20 },
        },
      ],
    });

    expect(article.documentMetadata).toMatchObject({ dateFrom: "2026-06-01", dateTo: "2026-06-01" });
    expect(registry.get("profile").apply({ documentMetadata: {}, chunks: [], facts: [] }).documentMetadata).toEqual({});
    expect(registry.get("generic").apply({ documentMetadata: {}, chunks: [], facts: [] }).documentMetadata).toEqual({});
  });
});
