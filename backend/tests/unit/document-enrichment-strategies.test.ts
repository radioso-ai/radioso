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
        { kind: "event_date", dateFrom: "2026-07-03", dateTo: "2026-07-03", sourceRange: { start: 0, end: 10 } },
        { kind: "event_date", dateFrom: "2026-07-05", sourceRange: { start: 20, end: 30 } },
      ],
    });

    expect(result.documentMetadata).toEqual({
      sourceUrl: "https://events.example",
      dateFrom: "2026-07-03",
      dateTo: "2026-07-05",
    });
  });

  const threeChunks = (): Array<{ chunkIndex: number; startOffset: number; endOffset: number; metadata: Record<string, unknown> }> => [
    { chunkIndex: 0, startOffset: 0, endOffset: 20, metadata: {} },
    { chunkIndex: 1, startOffset: 20, endOffset: 40, metadata: {} },
    { chunkIndex: 2, startOffset: 40, endOffset: 60, metadata: {} },
  ];

  it("dates only the chunks a fact is quoted from when the document carries several dates", () => {
    const result = createDefaultDocumentEnrichmentStrategyRegistry().get("event").apply({
      documentMetadata: {},
      chunks: threeChunks(),
      facts: [
        { kind: "event_date", dateFrom: "2026-12-07", sourceRange: { start: 2, end: 12 } },
        { kind: "event_date", dateFrom: "2026-12-11", sourceRange: { start: 42, end: 52 } },
      ],
    });

    expect(result.chunks.map((chunk) => chunk.metadata?.dateFrom ?? null)).toEqual(["2026-12-07", null, "2026-12-11"]);
    expect(result.documentMetadata).toEqual({ dateFrom: "2026-12-07", dateTo: "2026-12-11" });
    expect(result.appliedChunkCount).toBe(2);
  });

  it("dates the chunks no fact was quoted from with the range the title states", () => {
    const result = createDefaultDocumentEnrichmentStrategyRegistry().get("event").apply({
      documentMetadata: {},
      chunks: threeChunks(),
      facts: [
        // Registration closes in March; the retreat itself is dated only in the title.
        { kind: "event_date", dateFrom: "2027-03-15", sourceRange: { start: 42, end: 52 } },
        { kind: "event_date", dateFrom: "2027-04-30", dateTo: "2027-05-03", sourceRange: null },
      ],
      droppedFactCount: 0,
    });

    expect(result.chunks.map((chunk) => chunk.metadata)).toEqual([
      { dateFrom: "2027-04-30", dateTo: "2027-05-03" },
      { dateFrom: "2027-04-30", dateTo: "2027-05-03" },
      { dateFrom: "2027-03-15", dateTo: "2027-03-15" },
    ]);
    expect(result.documentMetadata).toEqual({ dateFrom: "2027-03-15", dateTo: "2027-05-03" });
    expect(result.appliedChunkCount).toBe(3);
  });

  it("dates every chunk of a document whose facts all name one date range", () => {
    const registry = createDefaultDocumentEnrichmentStrategyRegistry();
    const result = registry.get("event").apply({
      documentMetadata: {},
      chunks: [
        { chunkIndex: 0, startOffset: 0, endOffset: 20, metadata: {} },
        { chunkIndex: 1, startOffset: 20, endOffset: 40, metadata: {} },
      ],
      facts: [
        { kind: "event_date", dateFrom: "2026-12-12", dateTo: "2026-12-14", sourceRange: { start: 22, end: 30 } },
        { kind: "event_date", dateFrom: "2026-12-12", dateTo: "2026-12-14", sourceRange: null },
      ],
      droppedFactCount: 0,
    });

    expect(result.chunks.map((chunk) => chunk.metadata)).toEqual([
      { dateFrom: "2026-12-12", dateTo: "2026-12-14" },
      { dateFrom: "2026-12-12", dateTo: "2026-12-14" },
    ]);
    expect(result.appliedChunkCount).toBe(2);
  });

  const fiveCourseChunks = (): ReturnType<typeof threeChunks> =>
    [0, 1, 2, 3, 4].map((index) => ({ chunkIndex: index, startOffset: index * 20, endOffset: index * 20 + 20, metadata: {} }));

  it("dates only the chunks each fact is quoted from when the caller does not say whether facts were dropped", () => {
    const result = createDefaultDocumentEnrichmentStrategyRegistry().get("event").apply({
      documentMetadata: {},
      chunks: threeChunks(),
      facts: [{ kind: "event_date", dateFrom: "2026-12-12", sourceRange: { start: 22, end: 30 } }],
    });

    expect(result.chunks.map((chunk) => chunk.metadata.dateFrom ?? null)).toEqual([null, "2026-12-12", null]);
  });

  it("dates only the surviving fact's chunk when the run dropped other facts", () => {
    const result = createDefaultDocumentEnrichmentStrategyRegistry().get("event").apply({
      documentMetadata: {},
      chunks: fiveCourseChunks(),
      facts: [{ kind: "event_date", dateFrom: "2026-12-09", sourceRange: { start: 42, end: 50 } }],
      droppedFactCount: 4,
    });

    expect(result.chunks.map((chunk) => chunk.metadata.dateFrom ?? null)).toEqual([null, null, "2026-12-09", null, null]);
    expect(result.appliedChunkCount).toBe(1);
  });

  it("dates only the resolved fact's chunk when another fact's date is unresolved", () => {
    const result = createDefaultDocumentEnrichmentStrategyRegistry().get("event").apply({
      documentMetadata: {},
      chunks: threeChunks(),
      facts: [
        { kind: "event_date", dateFrom: "2026-12-12", dateTo: "2026-12-14", sourceRange: { start: 22, end: 30 } },
        { kind: "event_date", unresolvedText: "the following weekend", sourceRange: { start: 42, end: 48 } },
      ],
      droppedFactCount: 0,
    });

    expect(result.chunks.map((chunk) => chunk.metadata.dateFrom ?? null)).toEqual([null, "2026-12-12", null]);
  });

  it("leaves uncovered chunks undated by the title's range when the run dropped a fact", () => {
    const result = createDefaultDocumentEnrichmentStrategyRegistry().get("event").apply({
      documentMetadata: {},
      chunks: threeChunks(),
      facts: [
        { kind: "event_date", dateFrom: "2027-03-15", sourceRange: { start: 42, end: 52 } },
        { kind: "event_date", dateFrom: "2027-04-30", dateTo: "2027-05-03", sourceRange: null },
      ],
      droppedFactCount: 1,
    });

    expect(result.chunks.map((chunk) => chunk.metadata.dateFrom ?? null)).toEqual([null, null, "2027-03-15"]);
  });

  it("gives a chunk holding several dated facts the span from the earliest to the latest", () => {
    const result = createDefaultDocumentEnrichmentStrategyRegistry().get("event").apply({
      documentMetadata: {},
      chunks: [
        { chunkIndex: 0, startOffset: 0, endOffset: 60, metadata: {} },
        { chunkIndex: 1, startOffset: 60, endOffset: 80, metadata: {} },
      ],
      facts: [
        { kind: "event_date", dateFrom: "2026-12-11", dateTo: "2026-12-12", sourceRange: { start: 40, end: 50 } },
        { kind: "event_date", dateFrom: "2026-12-07", sourceRange: { start: 2, end: 12 } },
        { kind: "event_date", dateFrom: "2026-12-09", sourceRange: { start: 20, end: 30 } },
        { kind: "event_date", dateFrom: "2026-12-13", sourceRange: { start: 62, end: 70 } },
      ],
      droppedFactCount: 0,
    });

    expect(result.chunks.map((chunk) => chunk.metadata)).toEqual([
      { dateFrom: "2026-12-07", dateTo: "2026-12-12" },
      { dateFrom: "2026-12-13", dateTo: "2026-12-13" },
    ]);
  });

  it("attaches article publication dates at document level and leaves profile/generic temporal facts empty", () => {
    const registry = createDefaultDocumentEnrichmentStrategyRegistry();
    const article = registry.get("article").apply({
      documentMetadata: {},
      chunks: [],
      facts: [
        {
          kind: "article_date",
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
