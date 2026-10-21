import { describe, expect, it } from "vitest";

import type { DocumentEnrichmentProvenance } from "../../src/modules/documents/domain/enrichment/documentEnrichmentContract.js";
import type { DocumentEnrichmentStrategy } from "../../src/modules/documents/domain/enrichment/enrichmentStrategies.js";
import { createDefaultDocumentEnrichmentStrategyRegistry } from "../../src/modules/documents/domain/enrichment/enrichmentStrategies.js";
import {
  applyTemporalTagsWithOwnership,
  prepareRevisionTags,
  sourceSyncsDocumentDates,
  publishEnrichmentProvenance,
  relinquishGeneratedKeys,
  resolveExtractionOwnedKeys,
  stripLegacyProvenanceTag,
} from "../../src/modules/documents/domain/enrichment/generatedTagOwnership.js";

const provenance = (generatedKeys: string[]): DocumentEnrichmentProvenance => ({
  status: "applied",
  matchedTypeKey: "product",
  catalogRevision: "3",
  generatedKeys,
  dateOwnershipRecorded: true,
});

// Provenance written before extraction recorded its ownership of the dates.
const unmarkedEventRun = (overrides: Partial<DocumentEnrichmentProvenance> = {}): DocumentEnrichmentProvenance => ({
  status: "applied",
  shape: "event",
  factCount: 2,
  appliedChunkCount: 1,
  ...overrides,
});

describe("extraction-owned keys", () => {
  it("owns nothing on a document that has no provenance", () => {
    expect(resolveExtractionOwnedKeys(null)).toEqual([]);
  });

  it("owns exactly the recorded generated keys, dates included", () => {
    expect(resolveExtractionOwnedKeys(provenance(["price", "dateFrom", "dateTo"]))).toEqual(["price", "dateFrom", "dateTo"]);
    expect(resolveExtractionOwnedKeys(provenance(["price"]))).toEqual(["price"]);
  });

  it("owns the dates of an unmarked applied event or article run that dated a chunk", () => {
    expect(resolveExtractionOwnedKeys(unmarkedEventRun())).toEqual(["dateFrom", "dateTo"]);
    expect(resolveExtractionOwnedKeys(unmarkedEventRun({ shape: "article", appliedChunkCount: 3 }))).toEqual(["dateFrom", "dateTo"]);
    expect(resolveExtractionOwnedKeys(unmarkedEventRun({ generatedKeys: [] }))).toEqual(["dateFrom", "dateTo"]);
  });

  it("leaves the dates to the operator when unmarked provenance cannot show extraction wrote them", () => {
    expect(resolveExtractionOwnedKeys(unmarkedEventRun({ status: "failed" }))).toEqual([]);
    expect(resolveExtractionOwnedKeys(unmarkedEventRun({ appliedChunkCount: 0 }))).toEqual([]);
    expect(resolveExtractionOwnedKeys(unmarkedEventRun({ shape: "generic" }))).toEqual([]);
    expect(resolveExtractionOwnedKeys({ status: "applied" })).toEqual([]);
  });

  it("reads the matched catalog type before the model's declared shape", () => {
    // The model said event, but the event type was disabled and the run fell back to generic.
    expect(resolveExtractionOwnedKeys(unmarkedEventRun({ matchedTypeKey: "generic" }))).toEqual([]);
    expect(resolveExtractionOwnedKeys(unmarkedEventRun({ shape: "generic", matchedTypeKey: "event" }))).toEqual(["dateFrom", "dateTo"]);
  });

  it("trusts marked provenance over the run shape", () => {
    expect(resolveExtractionOwnedKeys({ ...unmarkedEventRun(), generatedKeys: [], dateOwnershipRecorded: true })).toEqual([]);
  });
});

describe("tags on a new revision", () => {
  const metadata = { price: 10, dateFrom: "2026-01-01", dateTo: "2026-01-02", colour: "red" };

  it("keeps every tag on the document but projects only operator tags onto chunks when extraction runs", () => {
    const result = prepareRevisionTags({
      metadata,
      provenance: provenance(["price", "dateFrom", "dateTo"]),
      extractionEnabled: true,
    });

    expect(result).toEqual({ projectedMetadata: { colour: "red" } });
  });

  it("clears only extraction-owned tags when extraction will not run on the revision", () => {
    expect(prepareRevisionTags({
      metadata,
      provenance: provenance(["price", "dateFrom", "dateTo"]),
      extractionEnabled: false,
    })).toEqual({ projectedMetadata: { colour: "red" }, clearedDocument: { metadata: { colour: "red" } } });

    const operatorDates = { dateFrom: "2026-01-01", dateTo: "2026-01-02", colour: "red" };
    expect(prepareRevisionTags({
      metadata,
      provenance: provenance(["price"]),
      extractionEnabled: false,
    })).toEqual({ projectedMetadata: operatorDates, clearedDocument: { metadata: operatorDates } });
  });

  it("keeps operator-written dates under unmarked provenance of a failed run", () => {
    const dates = { dateFrom: "2026-01-01", dateTo: "2026-01-02" };
    expect(prepareRevisionTags({
      metadata: dates,
      provenance: unmarkedEventRun({ status: "failed", appliedChunkCount: 0 }),
      extractionEnabled: true,
    })).toEqual({ projectedMetadata: dates });
  });

  it("leaves a never-enriched document untouched", () => {
    const result = prepareRevisionTags({ metadata, provenance: null, extractionEnabled: false });

    expect(result.projectedMetadata).toBe(metadata);
    expect(result.clearedDocument).toBeUndefined();
  });
});

describe("legacy nested provenance", () => {
  it("is stripped once a document has been enriched", () => {
    expect(stripLegacyProvenanceTag({ enrichment: "x", dateFrom: "2026-01-01" }, true)).toEqual({ dateFrom: "2026-01-01" });
  });

  it("leaves a never-enriched document's metadata alone", () => {
    const metadata = { enrichment: "x" };

    expect(stripLegacyProvenanceTag(metadata, false)).toBe(metadata);
  });
});

describe("temporal tags under ownership", () => {
  const chunks = [
    { chunkIndex: 0, startOffset: 0, endOffset: 20, metadata: { dateFrom: "2026-03-01", dateTo: "2026-03-07" } },
    { chunkIndex: 1, startOffset: 20, endOffset: 40, metadata: { dateFrom: "2026-03-01", dateTo: "2026-03-07" } },
  ];
  const facts = [
    { kind: "event_date" as const, dateFrom: "2026-03-02", dateTo: "2026-03-02", sourceRange: { start: 0, end: 10 } },
    { kind: "event_date" as const, dateFrom: "2026-03-05", sourceRange: { start: 25, end: 30 } },
  ];
  const eventStrategy: DocumentEnrichmentStrategy = createDefaultDocumentEnrichmentStrategyRegistry().get("event");
  const OPERATOR_SPAN = { dateFrom: "2026-03-01", dateTo: "2026-03-07" };

  it("writes no date anywhere when the operator dated the document, and counts the collision", () => {
    const result = applyTemporalTagsWithOwnership(eventStrategy, {
      documentMetadata: { dateFrom: "2026-03-01", dateTo: "2026-03-07" },
      chunks,
      facts,
      droppedFactCount: 0,
    });

    expect(result.documentMetadata).toEqual({ dateFrom: "2026-03-01", dateTo: "2026-03-07" });
    expect(result.chunks.map((chunk) => chunk.metadata)).toEqual(chunks.map((chunk) => chunk.metadata));
    expect(result.generatedKeys).toEqual([]);
    expect(result.skippedCollision).toBe(2);
    expect(result.appliedChunkCount).toBe(0);
  });

  it("treats one operator-written date as owning the pair", () => {
    const result = applyTemporalTagsWithOwnership(eventStrategy, {
      documentMetadata: { dateFrom: "2026-03-01" },
      chunks,
      facts,
      droppedFactCount: 0,
    });

    expect(result.documentMetadata).toEqual({ dateFrom: "2026-03-01" });
    expect(result.generatedKeys).toEqual([]);
  });

  it("records the dates it writes as generated when the document carries none", () => {
    const result = applyTemporalTagsWithOwnership(eventStrategy, {
      documentMetadata: { audience: "staff" },
      chunks: chunks.map((chunk) => ({ ...chunk, metadata: {} })),
      facts,
      droppedFactCount: 0,
    });

    expect(result.documentMetadata).toEqual({ audience: "staff", dateFrom: "2026-03-02", dateTo: "2026-03-05" });
    expect(result.chunks[1]?.metadata).toEqual({ dateFrom: "2026-03-05", dateTo: "2026-03-05" });
    expect(result.generatedKeys).toEqual(["dateFrom", "dateTo"]);
    expect(result.skippedCollision).toBe(0);
  });

  it("treats dates the source stamps on every chunk as the operator's", () => {
    const sourceDated = chunks.map((chunk) => ({ ...chunk, metadata: { region: "eu", ...OPERATOR_SPAN } }));
    const result = applyTemporalTagsWithOwnership(
      eventStrategy,
      { documentMetadata: { audience: "staff" }, chunks: sourceDated, facts, droppedFactCount: 0 },
      { sourceMetadata: { region: "eu", ...OPERATOR_SPAN } },
    );

    expect(result.documentMetadata).toEqual({ audience: "staff" });
    expect(result.chunks).toEqual(sourceDated);
    expect(result.generatedKeys).toEqual([]);
    expect(result.skippedCollision).toBe(2);
  });

  it("reads empty dates as absent", () => {
    const result = applyTemporalTagsWithOwnership(
      eventStrategy,
      { documentMetadata: { dateFrom: "", dateTo: null }, chunks, facts, droppedFactCount: 0 },
      { sourceMetadata: { dateFrom: "  " } },
    );

    expect(result.documentMetadata).toEqual({ dateFrom: "2026-03-02", dateTo: "2026-03-05" });
    expect(result.generatedKeys).toEqual(["dateFrom", "dateTo"]);
  });

  it("keeps an empty date the operator wrote when the run reads none", () => {
    const documentMetadata = { dateFrom: "", audience: "staff" };
    const result = applyTemporalTagsWithOwnership(eventStrategy, { documentMetadata, chunks, facts: [], droppedFactCount: 0 });

    expect(result.documentMetadata).toBe(documentMetadata);
    expect(result.generatedKeys).toEqual([]);
  });

  it("replaces the dates a syncing source wrote when the run reads its own", () => {
    const publishDay = { published_at: "2026-01-10T08:00:00", dateFrom: "2026-01-10" };
    const result = applyTemporalTagsWithOwnership(
      eventStrategy,
      {
        documentMetadata: publishDay,
        chunks: chunks.map((chunk) => ({ ...chunk, metadata: { dateFrom: "2026-01-10" } })),
        // Two events, both on the second chunk: no single range spreads to the first.
        facts: [...facts.slice(1), { kind: "event_date" as const, dateFrom: "2026-03-06", sourceRange: { start: 32, end: 36 } }],
        droppedFactCount: 0,
      },
      { documentDatesAreSyncDefaults: true },
    );

    expect(result.documentMetadata).toEqual({ published_at: "2026-01-10T08:00:00", dateFrom: "2026-03-05", dateTo: "2026-03-06" });
    // The publish day comes off the chunk no event covers.
    expect(result.chunks.map((chunk) => chunk.metadata)).toEqual([{}, { dateFrom: "2026-03-05", dateTo: "2026-03-06" }]);
    expect(result.generatedKeys).toEqual(["dateFrom", "dateTo"]);
    expect(result.skippedCollision).toBe(0);
  });

  it("keeps the dates a syncing source wrote when the run reads none", () => {
    const publishDay = { dateFrom: "2026-01-10" };
    const result = applyTemporalTagsWithOwnership(
      eventStrategy,
      { documentMetadata: publishDay, chunks, facts: [], droppedFactCount: 0 },
      { documentDatesAreSyncDefaults: true },
    );

    expect(result.documentMetadata).toBe(publishDay);
    expect(result.generatedKeys).toEqual([]);
  });

  it("still defers to source tag dates on a syncing source", () => {
    const result = applyTemporalTagsWithOwnership(
      eventStrategy,
      { documentMetadata: { dateFrom: "2026-01-10" }, chunks, facts, droppedFactCount: 0 },
      { documentDatesAreSyncDefaults: true, sourceMetadata: OPERATOR_SPAN },
    );

    expect(result.documentMetadata).toEqual({ dateFrom: "2026-01-10" });
    expect(result.skippedCollision).toBe(2);
  });

  it("records nothing when the strategy found no resolved date", () => {
    const result = applyTemporalTagsWithOwnership(eventStrategy, {
      documentMetadata: { dateFrom: "2026-03-01" },
      chunks,
      facts: [],
      droppedFactCount: 0,
    });

    expect(result.generatedKeys).toEqual([]);
    expect(result.skippedCollision).toBe(0);
  });
});

describe("sources that sync document dates", () => {
  it("are connectors, whose upstream rewrites a document's metadata on every sync", () => {
    expect(sourceSyncsDocumentDates("connector")).toBe(true);
  });

  it("exclude sources an API client or operator files documents under", () => {
    expect(sourceSyncsDocumentDates("website")).toBe(false);
    expect(sourceSyncsDocumentDates("api")).toBe(false);
    expect(sourceSyncsDocumentDates("upload")).toBe(false);
    expect(sourceSyncsDocumentDates(null)).toBe(false);
  });
});

describe("manual edit relinquishment", () => {
  it("drops a generated key whose value a manual write changed", () => {
    const result = relinquishGeneratedKeys({
      previousProvenance: provenance(["price", "category"]),
      previousMetadata: { price: 10, category: "lighting" },
      nextMetadata: { price: 12, category: "lighting" },
      contentChanged: false,
    });

    expect(result?.generatedKeys).toEqual(["category"]);
    expect(result).toMatchObject({ matchedTypeKey: "product", catalogRevision: "3", dateOwnershipRecorded: true });
  });

  it("drops a generated key a manual write removed", () => {
    const result = relinquishGeneratedKeys({
      previousProvenance: provenance(["price"]),
      previousMetadata: { price: 10 },
      nextMetadata: {},
      contentChanged: false,
    });

    expect(result?.generatedKeys).toEqual([]);
  });

  it("keeps ownership when the manual write leaves generated values untouched", () => {
    const result = relinquishGeneratedKeys({
      previousProvenance: provenance(["price"]),
      previousMetadata: { price: 10 },
      nextMetadata: { price: 10, colour: "red" },
      contentChanged: false,
    });

    expect(result).toBeUndefined();
  });

  it("does nothing when the document has no generated keys", () => {
    const result = relinquishGeneratedKeys({
      previousProvenance: provenance([]),
      previousMetadata: { price: 10 },
      nextMetadata: {},
      contentChanged: false,
    });

    expect(result).toBeUndefined();
  });

  it("hands both dates to the operator when a manual write changes either one", () => {
    const result = relinquishGeneratedKeys({
      previousProvenance: provenance(["price", "dateFrom", "dateTo"]),
      previousMetadata: { price: 10, dateFrom: "2026-03-01", dateTo: "2026-03-07" },
      nextMetadata: { price: 10, dateFrom: "2026-03-01", dateTo: "2026-03-08" },
      contentChanged: false,
    });

    expect(result?.generatedKeys).toEqual(["price"]);
  });

  it("records the inferred date ownership of unmarked provenance when it relinquishes", () => {
    const changedDates = relinquishGeneratedKeys({
      previousProvenance: unmarkedEventRun(),
      previousMetadata: { dateFrom: "2026-03-01", dateTo: "2026-03-07" },
      nextMetadata: { dateFrom: "2026-03-02", dateTo: "2026-03-07" },
      contentChanged: false,
    });
    expect(changedDates).toMatchObject({ generatedKeys: [], dateOwnershipRecorded: true, shape: "event" });

    const unchangedDates = relinquishGeneratedKeys({
      previousProvenance: unmarkedEventRun(),
      previousMetadata: { dateFrom: "2026-03-01", dateTo: "2026-03-07" },
      nextMetadata: { dateFrom: "2026-03-01", dateTo: "2026-03-07", colour: "red" },
      contentChanged: false,
    });
    expect(unchangedDates).toMatchObject({ generatedKeys: [], dateOwnershipRecorded: true });

    const otherTagOnly = relinquishGeneratedKeys({
      previousProvenance: unmarkedEventRun(),
      previousMetadata: { dateFrom: "2026-03-01", dateTo: "2026-03-07" },
      nextMetadata: { colour: "red", dateFrom: null },
      contentChanged: false,
    });
    expect(otherTagOnly).toMatchObject({ generatedKeys: [] });
  });

  it("hands unmarked dates to the operator when a write supplies either one, whatever its value", () => {
    const result = relinquishGeneratedKeys({
      previousProvenance: unmarkedEventRun({ generatedKeys: ["price"] }),
      previousMetadata: { price: 10, dateFrom: "2026-03-01", dateTo: "2026-03-07" },
      nextMetadata: { price: 10, dateFrom: "2026-03-01", dateTo: "2026-03-07" },
      contentChanged: false,
    });

    expect(result?.generatedKeys).toEqual(["price"]);
  });

  it("keeps marked date ownership when a write sends the same dates back", () => {
    const result = relinquishGeneratedKeys({
      previousProvenance: provenance(["dateFrom", "dateTo"]),
      previousMetadata: { dateFrom: "2026-03-01", dateTo: "2026-03-07" },
      nextMetadata: { dateFrom: "2026-03-01", dateTo: "2026-03-07", colour: "red" },
      contentChanged: false,
    });

    expect(result).toBeUndefined();
  });

  it("leaves unmarked dates with extraction when a content edit echoes them unchanged", () => {
    const result = relinquishGeneratedKeys({
      previousProvenance: unmarkedEventRun(),
      previousMetadata: { dateFrom: "2026-03-01", dateTo: "2026-03-07" },
      nextMetadata: { dateFrom: "2026-03-01", dateTo: "2026-03-07" },
      contentChanged: true,
    });

    expect(result).toBeUndefined();
  });

  it("still hands unmarked dates over when a content edit changes either one", () => {
    const result = relinquishGeneratedKeys({
      previousProvenance: unmarkedEventRun(),
      previousMetadata: { dateFrom: "2026-03-01", dateTo: "2026-03-07" },
      nextMetadata: { dateFrom: "2026-03-01", dateTo: "2026-03-08" },
      contentChanged: true,
    });

    expect(result).toMatchObject({ generatedKeys: [], dateOwnershipRecorded: true });
  });

  it("leaves unmarked provenance alone when it owns no dates to hand over", () => {
    const result = relinquishGeneratedKeys({
      previousProvenance: unmarkedEventRun({ shape: "generic", generatedKeys: ["price"] }),
      previousMetadata: { price: 10 },
      nextMetadata: { price: 10, dateFrom: "2026-03-01", dateTo: "2026-03-07" },
      contentChanged: false,
    });

    expect(result).toBeUndefined();
  });
});

describe("published provenance", () => {
  it("lists the keys extraction owns and keeps the ownership marker internal", () => {
    expect(publishEnrichmentProvenance(provenance(["price", "dateFrom", "dateTo"]))).toEqual({
      status: "applied",
      matchedTypeKey: "product",
      catalogRevision: "3",
      generatedKeys: ["price", "dateFrom", "dateTo"],
    });
  });

  it("publishes the dates unmarked provenance implies extraction owns", () => {
    expect(publishEnrichmentProvenance(unmarkedEventRun())).toEqual({
      ...unmarkedEventRun(),
      generatedKeys: ["dateFrom", "dateTo"],
    });
  });

  it("publishes provenance that owns nothing exactly as stored", () => {
    const stored: DocumentEnrichmentProvenance = { status: "failed", failureReason: "provider_error" };

    expect(publishEnrichmentProvenance(stored)).toEqual(stored);
    expect(publishEnrichmentProvenance(null)).toBeNull();
  });
});
