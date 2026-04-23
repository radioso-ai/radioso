import { afterEach, describe, expect, it, vi } from "vitest";

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
  afterEach(() => {
    vi.useRealTimers();
  });

  it("filters candidates by exact metadata match", () => {
    const service = new MetadataRuleScoringService();

    const result = service.apply({
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
        },
      ],
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.chunkId).toBe("chunk-1");
  });

  it("boosts candidates that satisfy contains rules", () => {
    const service = new MetadataRuleScoringService();

    const result = service.apply({
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
        },
      ],
    });

    expect(result.candidates[0]?.chunkId).toBe("chunk-1");
    expect(result.appliedRules).toContainEqual({
      signalKey: "metadata.parsedData.url",
      mode: "boost_only",
      outcome: "applied",
      summary: "parsedData.url contains example.com",
    });
  });

  it("evaluates today() dynamically for date comparisons", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T12:00:00.000Z"));

    const service = new MetadataRuleScoringService();

    const result = service.apply({
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
});
