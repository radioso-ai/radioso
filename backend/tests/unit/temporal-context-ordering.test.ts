import { describe, expect, it } from "vitest";

import { orderTemporalPromptContexts } from "../../src/modules/retrieval/services/temporal/temporalContextOrdering.js";
import type { RerankedCandidate } from "../../src/modules/retrieval/domain/retrievalPipelineTypes.js";

const candidate = (input: {
  chunkId: string;
  rank: number;
  dateFrom?: string;
  dateTo?: string;
}): RerankedCandidate => ({
  chunkId: input.chunkId,
  documentId: `doc-${input.chunkId}`,
  title: `Event ${input.chunkId}`,
  content: `Event ${input.chunkId} details.`,
  similarity: 1 - input.rank / 100,
  retrievalSources: ["semantic_original"],
  retrievalText: `Event ${input.chunkId} details.`,
  semanticScore: 1 - input.rank / 100,
  lexicalScore: 0,
  relevanceScore: 1 - input.rank / 100,
  rerankPosition: input.rank,
  metadata: {
    ...(input.dateFrom ? { dateFrom: input.dateFrom } : {}),
    ...(input.dateTo ? { dateTo: input.dateTo } : {}),
  },
});

describe("temporal context ordering", () => {
  it("orders dated event contexts by start date, end date, then rerank position", () => {
    const result = orderTemporalPromptContexts({
      contexts: [
        candidate({ chunkId: "undated-first", rank: 0 }),
        candidate({ chunkId: "later", rank: 1, dateFrom: "2026-09-20", dateTo: "2026-09-20" }),
        candidate({ chunkId: "tie-later-end", rank: 2, dateFrom: "2026-08-10", dateTo: "2026-08-12" }),
        candidate({ chunkId: "tie-earlier-end", rank: 3, dateFrom: "2026-08-10", dateTo: "2026-08-11" }),
        candidate({ chunkId: "earliest", rank: 4, dateFrom: "2026-07-03", dateTo: "2026-07-03" }),
        candidate({ chunkId: "undated-last", rank: 5 }),
      ],
      enabled: true,
      queryShape: "event_date_lookup",
      temporalQueryMode: "listing",
      today: "2026-07-02",
    });

    expect(result.applied).toBe(true);
    expect(result.orderedContexts.map((context) => context.chunkId)).toEqual([
      "earliest",
      "tie-earlier-end",
      "tie-later-end",
      "later",
      "undated-first",
      "undated-last",
    ]);
  });

  it("preserves rerank ordering when disabled or not an event date lookup", () => {
    const contexts = [
      candidate({ chunkId: "undated", rank: 0 }),
      candidate({ chunkId: "dated", rank: 1, dateFrom: "2026-07-03", dateTo: "2026-07-03" }),
    ];

    expect(orderTemporalPromptContexts({
      contexts,
      enabled: false,
      queryShape: "event_date_lookup",
      temporalQueryMode: "listing",
      today: "2026-07-02",
    })).toMatchObject({
      applied: false,
      orderedContexts: contexts,
    });

    expect(orderTemporalPromptContexts({
      contexts,
      enabled: true,
      queryShape: "default_hybrid",
      temporalQueryMode: "listing",
      today: "2026-07-02",
    })).toMatchObject({
      applied: false,
      orderedContexts: contexts,
    });
  });
});
