import { describe, expect, it } from "vitest";

import { defaultAttributeControls } from "../../src/modules/settings/domain/retrievalSettings.js";
import type { RetrievedCandidate } from "../../src/modules/retrieval/domain/retrievalPipelineTypes.js";
import { AttributeMatchScoringService } from "../../src/modules/retrieval/services/attributeMatchScoringService.js";
import { SemanticQueryConstraintService } from "../../src/modules/retrieval/services/semanticQueryConstraintService.js";

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

const buildSemanticParser = () =>
  new SemanticQueryConstraintService({
    async interpret({ query }) {
      expect(query).toBe("Find retreats in Estonia under 300 EUR after 2026-06-10");
      return {
        semanticQuery: "retreats in Estonia under 300 EUR after 2026-06-10",
        lexicalQuery: "retreats in Estonia under 300 EUR after 2026-06-10",
        constraints: [
          {
            signalKey: "document_location",
            operator: "match",
            confidence: 0.95,
            summary: "in Estonia",
            sourceText: "in Estonia",
            value: { matchKey: "estonia", displayName: "Estonia" },
          },
          {
            signalKey: "document_amount",
            operator: "lte",
            confidence: 0.95,
            summary: "under 300 EUR",
            sourceText: "under 300 EUR",
            value: { amount: 300, currencyCode: "EUR" },
          },
          {
            signalKey: "document_period",
            operator: "gte",
            confidence: 0.95,
            summary: "after 2026-06-10",
            sourceText: "after 2026-06-10",
            value: { date: "2026-06-10" },
          },
        ],
      };
    },
  });

describe("hybrid query constraints", () => {
  it("normalizes semantic constraints from the query service", async () => {
    const result = await buildSemanticParser().interpret({
      query: "Find retreats in Estonia under 300 EUR after 2026-06-10",
      history: [],
    });

    expect(result.semanticQuery).toBe("retreats in Estonia under 300 EUR after 2026-06-10");
    expect(result.lexicalQuery).toBe("retreats in Estonia under 300 EUR after 2026-06-10");
    expect(result.constraints).toEqual([
      expect.objectContaining({
        signalKey: "document_location",
        operator: "match",
        confidence: 0.95,
        sourceText: "in Estonia",
      }),
      expect.objectContaining({
        signalKey: "document_amount",
        operator: "lte",
        confidence: 0.95,
        sourceText: "under 300 EUR",
      }),
      expect.objectContaining({
        signalKey: "document_period",
        operator: "gte",
        confidence: 0.95,
        sourceText: "after 2026-06-10",
      }),
    ]);
  });

  it("uses hard filtering when high-confidence constraints and settings allow it", async () => {
    const service = new AttributeMatchScoringService();
    const parsed = await buildSemanticParser().interpret({
      query: "Find retreats in Estonia under 300 EUR after 2026-06-10",
      history: [],
    });
    const controls = defaultAttributeControls().map((control) =>
      control.signalKey === "document_location" || control.signalKey === "document_amount" || control.signalKey === "document_period"
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
      signalPolicies: controls,
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.chunkId).toBe("chunk-1");
    expect(result.appliedConstraints.every((constraint) => constraint.mode === "hard_filter")).toBe(true);
  });

  it("applies the date_range control independently of single-date controls", async () => {
    const service = new AttributeMatchScoringService();
    const parsed = await new SemanticQueryConstraintService({
      async interpret() {
        return {
          semanticQuery: "retreats after 2026-06-10",
          lexicalQuery: "retreats after 2026-06-10",
          constraints: [
            {
              signalKey: "document_period",
              operator: "gte",
              confidence: 0.95,
              summary: "after 2026-06-10",
              sourceText: "after 2026-06-10",
              value: { date: "2026-06-10" },
            },
          ],
        };
      },
    }).interpret({
      query: "Find retreats after 2026-06-10",
      history: [],
    });
    const controls = defaultAttributeControls().map((control) =>
      control.signalKey === "document_period"
        ? { ...control, mode: "hard_filter" as const }
        : control.signalKey === "document_date"
          ? { ...control, enabled: false }
          : control,
    );

    const result = service.apply({
      candidates: [candidate()],
      parsedQuery: parsed,
      signalPolicies: controls,
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.appliedConstraints).toContainEqual({
      signalKey: "document_period",
      mode: "hard_filter",
      outcome: "applied",
      summary: "after 2026-06-10",
    });
  });

  it("relaxes hard filters to boosts when too few candidates remain", async () => {
    const service = new AttributeMatchScoringService();
    const parsed = await buildSemanticParser().interpret({
      query: "Find retreats in Estonia under 300 EUR after 2026-06-10",
      history: [],
    });
    const controls = defaultAttributeControls().map((control) =>
      control.signalKey === "document_location" || control.signalKey === "document_amount" || control.signalKey === "document_period"
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
      signalPolicies: controls,
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.fallbackApplied).toBe(true);
    expect(result.appliedConstraints.some((constraint) => constraint.outcome === "relaxed")).toBe(true);
  });
});
