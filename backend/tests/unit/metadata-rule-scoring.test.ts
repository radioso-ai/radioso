import { describe, expect, it } from "vitest";

import { MetadataRuleScoringService } from "../../src/modules/retrieval/services/metadataRuleScoringService.js";
import type { RetrievedCandidate } from "../../src/modules/retrieval/domain/retrievalPipelineTypes.js";

const candidate = (overrides: Partial<RetrievedCandidate> = {}): RetrievedCandidate => ({
  chunkId: "chunk-1",
  documentId: "doc-1",
  title: "Document",
  content: "Document body",
  similarity: 0.5,
  retrievalSources: ["semantic_original"],
  retrievalText: "Document body",
  semanticScore: 0.5,
  lexicalScore: 0,
  attributeMatchScore: 0,
  metadata: {},
  ...overrides,
});

describe("metadata rule scoring", () => {
  it("filters candidates by exact metadata match", () => {
    const service = new MetadataRuleScoringService();

    const result = service.apply({
      today: "2026-06-01",
      candidates: [
        candidate({ metadata: { language: "en" } }),
        candidate({ chunkId: "chunk-2", documentId: "doc-2", metadata: { language: "et" } }),
      ],
      metadataRules: [
        {
          id: "language-filter",
          field: "language",
          valueType: "string",
          operator: "equals",
          value: "en",
          effect: "filter",
          enabled: true,
          triggerMode: "always_on",
        },
      ],
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.chunkId).toBe("chunk-1");
  });

  it("boosts candidates that satisfy contains rules", () => {
    const service = new MetadataRuleScoringService();

    const result = service.apply({
      today: "2026-06-01",
      candidates: [
        candidate({ chunkId: "chunk-1", documentId: "doc-1", metadata: { parsedData: { url: "https://example.com/a" } } }),
        candidate({ chunkId: "chunk-2", documentId: "doc-2", similarity: 0.55, metadata: { parsedData: { url: "https://other.test/b" } } }),
      ],
      metadataRules: [
        {
          id: "source-boost",
          field: "parsedData.url",
          valueType: "string",
          operator: "contains",
          value: "example.com",
          effect: "boost",
          enabled: true,
          triggerMode: "always_on",
        },
      ],
    });

    expect(result.candidates[0]?.chunkId).toBe("chunk-1");
    expect(result.candidates[0]?.similarity).toBeLessThanOrEqual(1);
    expect(result.candidates[0]?.fusedScore).toBe(result.candidates[0]?.similarity);
    expect(result.appliedRules).toContainEqual({
      signalKey: "metadata.parsedData.url",
      mode: "boost_only",
      outcome: "applied",
      summary: "parsedData.url contains example.com",
    });
  });

  it("evaluates today() as the run's date for date comparisons", () => {
    const service = new MetadataRuleScoringService();

    const result = service.apply({
      today: "2026-06-01",
      candidates: [
        candidate({ chunkId: "future", documentId: "future-doc", metadata: { dateFrom: "2026-06-15" } }),
        candidate({ chunkId: "past", documentId: "past-doc", metadata: { dateFrom: "2026-05-15" } }),
      ],
      metadataRules: [
        {
          id: "upcoming-filter",
          field: "dateFrom",
          valueType: "date",
          operator: "gte",
          value: "today()",
          effect: "filter",
          enabled: true,
          triggerMode: "always_on",
        },
      ],
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.chunkId).toBe("future");
    expect(result.appliedRules).toContainEqual({
      signalKey: "metadata.dateFrom",
      mode: "hard_filter",
      outcome: "applied",
      summary: "dateFrom >= today()",
    });
  });

  it("resolves today() to the date the run reads today as", () => {
    // 02:00 UTC on 3 November is still 2 November in Los Angeles: an event dated that day is not past.
    const rule = {
      id: "upcoming-filter",
      field: "dateFrom",
      valueType: "date" as const,
      operator: "gte" as const,
      value: "today()",
      effect: "filter" as const,
      enabled: true,
      triggerMode: "always_on" as const,
    };
    const candidates = [candidate({ chunkId: "local-today", documentId: "local-today-doc", metadata: { dateFrom: "2026-11-02" } })];
    const service = new MetadataRuleScoringService();

    expect(service.apply({ candidates, metadataRules: [rule], today: "2026-11-02" }).candidates.map((entry) => entry.chunkId))
      .toEqual(["local-today"]);
    expect(service.apply({ candidates, metadataRules: [rule], today: "2026-11-03" }).candidates).toHaveLength(0);
  });

  it("supports grouped OR conditions within a single rule", () => {
    const service = new MetadataRuleScoringService();

    const result = service.apply({
      today: "2026-06-01",
      candidates: [
        candidate({ chunkId: "events", metadata: { category: "event", language: "et" } }),
        candidate({ chunkId: "english", metadata: { category: "article", language: "en" } }),
        candidate({ chunkId: "other", metadata: { category: "article", language: "et" } }),
      ],
      metadataRules: [
        {
          id: "grouped-rule",
          field: "category",
          valueType: "string",
          operator: "equals",
          value: "event",
          combinator: "or",
          conditions: [
            {
              id: "condition-category",
              field: "category",
              valueType: "string",
              operator: "equals",
              value: "event",
            },
            {
              id: "condition-language",
              field: "language",
              valueType: "string",
              operator: "equals",
              value: "en",
            },
          ],
          effect: "filter",
          enabled: true,
          triggerMode: "always_on",
        },
      ],
    });

    expect(result.candidates.map((entry) => entry.chunkId)).toEqual(["events", "english"]);
    expect(result.appliedRules).toContainEqual({
      signalKey: "metadata.group.grouped-rule",
      mode: "hard_filter",
      outcome: "applied",
      summary: "(category equals event) OR (language equals en)",
    });
  });
});
