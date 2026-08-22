import { describe, expect, it } from "vitest";

import type { DocumentEnrichmentProvenance } from "../../src/modules/documents/domain/enrichment/documentEnrichmentContract.js";
import {
  relinquishGeneratedKeys,
  stripBuiltInTemporalTags,
  stripGeneratedEnrichmentTags,
} from "../../src/modules/documents/domain/enrichment/generatedTagOwnership.js";

const provenance = (generatedKeys: string[]): DocumentEnrichmentProvenance => ({
  status: "applied",
  matchedTypeKey: "product",
  catalogRevision: "3",
  generatedKeys,
});

describe("built-in temporal tag stripping", () => {
  it("leaves a never-enriched document's hand-authored dates alone", () => {
    const metadata = { dateFrom: "2026-01-01", source: "manual" };

    expect(stripBuiltInTemporalTags(metadata, false)).toBe(metadata);
  });

  it("clears the temporal tags and legacy nested provenance once a document has been enriched", () => {
    const metadata = { dateFrom: "2026-01-01", dateTo: "2026-01-02", enrichment: {}, source: "manual" };

    expect(stripBuiltInTemporalTags(metadata, true)).toEqual({ source: "manual" });
  });
});

describe("generated tag stripping", () => {
  it("returns metadata untouched when the document has no provenance", () => {
    const metadata = { price: 10 };

    expect(stripGeneratedEnrichmentTags(metadata, null)).toBe(metadata);
  });

  it("clears the recorded generated keys alongside the built-in temporal tags", () => {
    const metadata = { price: 10, category: "lighting", dateFrom: "2026-01-01", source: "manual" };

    expect(stripGeneratedEnrichmentTags(metadata, provenance(["price", "category"]))).toEqual({ source: "manual" });
  });

  it("keeps tags that were never generated", () => {
    const metadata = { price: 10, colour: "red" };

    expect(stripGeneratedEnrichmentTags(metadata, provenance(["price"]))).toEqual({ colour: "red" });
  });
});

describe("manual edit relinquishment", () => {
  it("drops a generated key whose value a manual write changed", () => {
    const result = relinquishGeneratedKeys({
      previousProvenance: provenance(["price", "category"]),
      previousMetadata: { price: 10, category: "lighting" },
      nextMetadata: { price: 12, category: "lighting" },
    });

    expect(result?.generatedKeys).toEqual(["category"]);
    expect(result).toMatchObject({ matchedTypeKey: "product", catalogRevision: "3" });
  });

  it("drops a generated key a manual write removed", () => {
    const result = relinquishGeneratedKeys({
      previousProvenance: provenance(["price"]),
      previousMetadata: { price: 10 },
      nextMetadata: {},
    });

    expect(result?.generatedKeys).toEqual([]);
  });

  it("keeps ownership when the manual write leaves generated values untouched", () => {
    const result = relinquishGeneratedKeys({
      previousProvenance: provenance(["price"]),
      previousMetadata: { price: 10 },
      nextMetadata: { price: 10, colour: "red" },
    });

    expect(result).toBeUndefined();
  });

  it("does nothing when the document has no generated keys", () => {
    const result = relinquishGeneratedKeys({
      previousProvenance: provenance([]),
      previousMetadata: { price: 10 },
      nextMetadata: {},
    });

    expect(result).toBeUndefined();
  });
});
