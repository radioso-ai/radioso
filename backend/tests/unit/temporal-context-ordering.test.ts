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

  it("pushes past events below upcoming and undated context instead of surfacing them first", () => {
    // Reproduces eval 93560082: a stale past event ("Kriya initiation" 2025-08-23) shares the
    // topic of a live 2026 event and, being the earliest date, was ascending-sorted to the top.
    const result = orderTemporalPromptContexts({
      contexts: [
        candidate({ chunkId: "past-2025", rank: 0, dateFrom: "2025-08-23", dateTo: "2025-08-23" }),
        candidate({ chunkId: "topic-info", rank: 1 }),
        candidate({ chunkId: "upcoming-2026", rank: 2, dateFrom: "2026-08-21", dateTo: "2026-08-23" }),
      ],
      enabled: true,
      queryShape: "event_date_lookup",
      temporalQueryMode: "topic_refinement",
      today: "2026-07-23",
    });

    expect(result.applied).toBe(true);
    expect(result.datedContextCount).toBe(2);
    expect(result.orderedContexts.map((context) => context.chunkId)).toEqual([
      "upcoming-2026",
      "topic-info",
      "past-2025",
    ]);
  });

  it("keeps a multi-day event that ends today or later as upcoming and orders past events most-recent first", () => {
    const result = orderTemporalPromptContexts({
      contexts: [
        candidate({ chunkId: "old-2023", rank: 0, dateFrom: "2023-09-13", dateTo: "2023-09-13" }),
        candidate({ chunkId: "ended-yesterday", rank: 1, dateFrom: "2026-07-20", dateTo: "2026-07-22" }),
        candidate({ chunkId: "ongoing", rank: 2, dateFrom: "2026-07-20", dateTo: "2026-07-25" }),
      ],
      enabled: true,
      queryShape: "event_date_lookup",
      temporalQueryMode: "topic_refinement",
      today: "2026-07-23",
    });

    expect(result.orderedContexts.map((context) => context.chunkId)).toEqual([
      "ongoing",
      "ended-yesterday",
      "old-2023",
    ]);
  });

  it("keeps the stronger rerank result ahead among past events sharing the same dates", () => {
    const result = orderTemporalPromptContexts({
      contexts: [
        candidate({ chunkId: "past-weak", rank: 5, dateFrom: "2025-08-23", dateTo: "2025-08-23" }),
        candidate({ chunkId: "past-strong", rank: 1, dateFrom: "2025-08-23", dateTo: "2025-08-23" }),
        candidate({ chunkId: "upcoming", rank: 3, dateFrom: "2026-08-21", dateTo: "2026-08-23" }),
      ],
      enabled: true,
      queryShape: "event_date_lookup",
      temporalQueryMode: "topic_refinement",
      today: "2026-07-23",
    });

    // Past events stay below the upcoming one; on identical dates the better rerank leads.
    expect(result.orderedContexts.map((context) => context.chunkId)).toEqual([
      "upcoming",
      "past-strong",
      "past-weak",
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

  it("leads with the events in a requested range, then other upcoming events, then undated, then past events", () => {
    const result = orderTemporalPromptContexts({
      contexts: [
        candidate({ chunkId: "next-week", rank: 0, dateFrom: "2026-10-28", dateTo: "2026-10-28" }),
        candidate({ chunkId: "undated", rank: 1 }),
        candidate({ chunkId: "in-range-late", rank: 2, dateFrom: "2026-12-12", dateTo: "2026-12-13" }),
        candidate({ chunkId: "after-range", rank: 3, dateFrom: "2027-01-10", dateTo: "2027-01-10" }),
        candidate({ chunkId: "past", rank: 4, dateFrom: "2026-09-01", dateTo: "2026-09-01" }),
        candidate({ chunkId: "crosses-range-start", rank: 5, dateFrom: "2026-12-05", dateTo: "2026-12-08" }),
        candidate({ chunkId: "in-range-early", rank: 6, dateFrom: "2026-12-07", dateTo: "2026-12-07" }),
      ],
      enabled: true,
      queryShape: "event_date_lookup",
      temporalQueryMode: "listing",
      today: "2026-10-21",
      dateRange: { dateFrom: "2026-12-07", dateTo: "2026-12-13" },
    });

    expect(result).toMatchObject({
      applied: true,
      dateRange: { dateFrom: "2026-12-07", dateTo: "2026-12-13" },
      datedContextCount: 6,
    });
    expect(result.orderedContexts.map((context) => context.chunkId)).toEqual([
      "crosses-range-start",
      "in-range-early",
      "in-range-late",
      "next-week",
      "after-range",
      "undated",
      "past",
    ]);
  });

  it("leads with a requested range in the past when the question asks about one", () => {
    const result = orderTemporalPromptContexts({
      contexts: [
        candidate({ chunkId: "upcoming", rank: 0, dateFrom: "2026-11-02", dateTo: "2026-11-02" }),
        candidate({ chunkId: "last-week", rank: 1, dateFrom: "2026-10-14", dateTo: "2026-10-14" }),
      ],
      enabled: true,
      queryShape: "event_date_lookup",
      temporalQueryMode: "topic_refinement",
      today: "2026-10-21",
      dateRange: { dateFrom: "2026-10-12", dateTo: "2026-10-18" },
    });

    expect(result.orderedContexts.map((context) => context.chunkId)).toEqual(["last-week", "upcoming"]);
  });

  it("keeps an upcoming event just after the range ahead of undated context for a topic question", () => {
    // "Is the yoga retreat in March?" when it is in April: the April date must survive the cut.
    const result = orderTemporalPromptContexts({
      contexts: [
        candidate({ chunkId: "undated-yoga", rank: 0 }),
        candidate({ chunkId: "april-retreat", rank: 1, dateFrom: "2027-04-10", dateTo: "2027-04-12" }),
      ],
      enabled: true,
      queryShape: "event_date_lookup",
      temporalQueryMode: "topic_refinement",
      today: "2026-10-21",
      dateRange: { dateFrom: "2027-03-01", dateTo: "2027-03-31" },
    });

    expect(result.orderedContexts.map((context) => context.chunkId)).toEqual(["april-retreat", "undated-yoga"]);
  });

  it("orders a context dated only by its end date as that single day", () => {
    const inRange = orderTemporalPromptContexts({
      contexts: [
        candidate({ chunkId: "undated", rank: 0 }),
        candidate({ chunkId: "end-date-only", rank: 1, dateTo: "2026-12-09" }),
        candidate({ chunkId: "in-range", rank: 2, dateFrom: "2026-12-10", dateTo: "2026-12-10" }),
      ],
      enabled: true,
      queryShape: "event_date_lookup",
      temporalQueryMode: "listing",
      today: "2026-10-21",
      dateRange: { dateFrom: "2026-12-07", dateTo: "2026-12-13" },
    });
    const upcoming = orderTemporalPromptContexts({
      contexts: [
        candidate({ chunkId: "undated", rank: 0 }),
        candidate({ chunkId: "past-end-date-only", rank: 1, dateTo: "2026-09-01" }),
        candidate({ chunkId: "end-date-only", rank: 2, dateTo: "2026-11-04" }),
      ],
      enabled: true,
      queryShape: "event_date_lookup",
      temporalQueryMode: "listing",
      today: "2026-10-21",
    });

    expect(inRange.orderedContexts.map((context) => context.chunkId)).toEqual(["end-date-only", "in-range", "undated"]);
    expect(inRange.datedContextCount).toBe(2);
    expect(upcoming.orderedContexts.map((context) => context.chunkId)).toEqual(["end-date-only", "undated", "past-end-date-only"]);
  });

  it("orders an inverted date pair by the span between its two dates", () => {
    const result = orderTemporalPromptContexts({
      contexts: [
        candidate({ chunkId: "later", rank: 0, dateFrom: "2026-12-11", dateTo: "2026-12-11" }),
        candidate({ chunkId: "inverted", rank: 1, dateFrom: "2026-12-10", dateTo: "2026-12-05" }),
      ],
      enabled: true,
      queryShape: "event_date_lookup",
      temporalQueryMode: "listing",
      today: "2026-10-21",
      dateRange: { dateFrom: "2026-12-07", dateTo: "2026-12-13" },
    });

    expect(result.orderedContexts.map((context) => context.chunkId)).toEqual(["inverted", "later"]);
  });
});
