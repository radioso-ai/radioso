import { describe, expect, it } from "vitest";

import { defaultAttributeControls } from "../../src/modules/settings/domain/retrievalSettings.js";
import type { RetrievedCandidate } from "../../src/modules/retrieval/domain/retrievalPipelineTypes.js";
import { parseQueryConstraints } from "../../src/modules/retrieval/services/queryConstraintParser.js";
import { AttributeMatchScoringService } from "../../src/modules/retrieval/services/attributeMatchScoringService.js";

const candidate = (overrides: Partial<RetrievedCandidate> = {}): RetrievedCandidate => ({
  chunkId: "chunk-1",
  documentId: "doc-1",
  title: "Summer Retreat",
  content: "Summer retreat with lodging.",
  similarity: 0.5,
  retrievalSources: ["semantic_original"],
  retrievalText: "Summer Retreat with lodging",
  semanticScore: 0.5,
  lexicalScore: 0.4,
  structuredAttributes: {
    datePoints: [],
    dateRanges: [
      {
        start: "2026-06-12",
        end: "2026-06-15",
        confidence: 0.95,
        sourceText: "2026-06-12 to 2026-06-15",
      },
    ],
    moneyValues: [
      {
        amount: 290,
        currencyCode: "EUR",
        confidence: 0.95,
        sourceText: "290 EUR",
      },
    ],
    locations: [
      {
        matchKey: "estonia",
        displayName: "Estonia",
        confidence: 0.95,
        sourceText: "Estonia",
      },
    ],
  },
  ...overrides,
});

describe("hybrid query constraints", () => {
  it("parses supported query constraints for date, money, and location", () => {
    const result = parseQueryConstraints("Find retreats in Estonia under 300 EUR after 2026-06-10");

    expect(result.semanticQuery).toBe("retreats");
    expect(result.lexicalQuery).toBe("retreats");
    expect(result.constraints).toEqual([
      expect.objectContaining({
        family: "location",
        operator: "match",
        confidence: 0.95,
      }),
      expect.objectContaining({
        family: "money_value",
        operator: "lte",
        confidence: 0.95,
      }),
      expect.objectContaining({
        family: "date_point",
        operator: "gte",
        confidence: 0.95,
      }),
    ]);
  });

  it("uses hard filtering when high-confidence constraints and settings allow it", () => {
    const service = new AttributeMatchScoringService();
    const parsed = parseQueryConstraints("Find retreats in Estonia under 300 EUR after 2026-06-10");
    const controls = defaultAttributeControls().map((control) =>
      control.family === "location" || control.family === "money_value" || control.family === "date_point"
        ? { ...control, mode: "hard_filter" as const }
        : control,
    );

    const result = service.apply({
      candidates: [
        candidate(),
        candidate({
          chunkId: "chunk-2",
          documentId: "doc-2",
          title: "Expensive Retreat",
          structuredAttributes: {
            datePoints: [],
            dateRanges: [],
            moneyValues: [
              {
                amount: 390,
                currencyCode: "EUR",
                confidence: 0.95,
                sourceText: "390 EUR",
              },
            ],
            locations: [
              {
                matchKey: "estonia",
                displayName: "Estonia",
                confidence: 0.95,
                sourceText: "Estonia",
              },
            ],
          },
        }),
      ],
      parsedQuery: parsed,
      attributeControls: controls,
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.chunkId).toBe("chunk-1");
    expect(result.appliedConstraints.every((constraint) => constraint.mode === "hard_filter")).toBe(true);
  });

  it("relaxes hard filters to boosts when too few candidates remain", () => {
    const service = new AttributeMatchScoringService();
    const parsed = parseQueryConstraints("Find retreats in Estonia under 300 EUR after 2026-06-10");
    const controls = defaultAttributeControls().map((control) =>
      control.family === "location" || control.family === "money_value" || control.family === "date_point"
        ? { ...control, mode: "hard_filter" as const }
        : control,
    );

    const result = service.apply({
      candidates: [
        candidate({
          chunkId: "chunk-2",
          documentId: "doc-2",
          title: "Expensive Retreat",
          structuredAttributes: {
            datePoints: [],
            dateRanges: [],
            moneyValues: [
              {
                amount: 390,
                currencyCode: "EUR",
                confidence: 0.95,
                sourceText: "390 EUR",
              },
            ],
            locations: [
              {
                matchKey: "estonia",
                displayName: "Estonia",
                confidence: 0.95,
                sourceText: "Estonia",
              },
            ],
          },
        }),
      ],
      parsedQuery: parsed,
      attributeControls: controls,
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.fallbackApplied).toBe(true);
    expect(result.appliedConstraints.some((constraint) => constraint.outcome === "relaxed")).toBe(true);
  });
});
