import { describe, expect, it } from "vitest";

import type { RerankedCandidate, RetrievedCandidate } from "../../../src/modules/retrieval/domain/retrievalPipelineTypes.js";
import { PromptContextSelectorService } from "../../../src/modules/retrieval/services/promptContextSelectorService.js";
import {
  composeRangeAnswerPool,
  rangeAnswerSelectionStages,
} from "../../../src/modules/retrieval/services/temporal/rangeAnswerComposer.js";

const december = { dateFrom: "2026-12-01", dateTo: "2026-12-31" };
// The default answer pool size under production settings (rerankTopK 5, dateRangeListingContextTopK
// 20): `answerCandidatePoolSize` picks the larger of the two, so pool size equals the listing cap.
const DEFAULT_POOL_SIZE = 20;
const DEFAULT_RESERVED_COUNT = 4;
const DEFAULT_MAX_PASSAGES = 20;
const DEFAULT_MIN_PASSAGES = 12;

const candidate = (chunkId: string, metadata: Record<string, unknown> = {}, documentId = `doc-${chunkId}`): RetrievedCandidate => ({
  chunkId,
  documentId,
  title: documentId,
  content: `${chunkId} content with enough words to be useful in a prompt`,
  similarity: 0.5,
  retrievalSources: ["semantic_rewritten"],
  retrievalText: chunkId,
  semanticScore: 0.5,
  lexicalScore: 0,
  metadata,
});
const inDecember = (chunkId: string, documentId?: string) =>
  candidate(chunkId, { dateFrom: "2026-12-10", dateTo: "2026-12-10" }, documentId);
// Dated entirely before the requested December range: a passage from a different period's
// digest, the shape of passage this fix keeps out of the reserved slots.
const inNovember = (chunkId: string, documentId?: string) =>
  candidate(chunkId, { dateFrom: "2026-11-10", dateTo: "2026-11-16" }, documentId);
// Pool order, tagged as already-ranked: how a reranked pool looks with reranking disabled
// (the production default), where the pool's own relevance order carries straight through.
const ranked = (candidates: RetrievedCandidate[]): RerankedCandidate[] =>
  candidates.map((entry, index) => ({ ...entry, relevanceScore: 1 - index / 1000, rerankPosition: index }));
const ids = (entries: Array<{ chunkId: string }>) => entries.map((entry) => entry.chunkId);

// Runs the composer and the selection stages together, as `contextSelectionStage.ts` does with
// reranking disabled, and returns the final selected contexts.
const composeAndSelect = (input: {
  rangeCandidates: RetrievedCandidate[];
  generalCandidates: RetrievedCandidate[];
  range?: { dateFrom: string; dateTo: string };
  poolSize?: number;
  reservedCount?: number;
  maxPassages?: number;
  minPassages?: number;
}) => {
  const plan = composeRangeAnswerPool({
    rangeCandidates: input.rangeCandidates,
    generalCandidates: input.generalCandidates,
    range: input.range ?? december,
    poolSize: input.poolSize ?? DEFAULT_POOL_SIZE,
    reservedCount: input.reservedCount ?? DEFAULT_RESERVED_COUNT,
  });
  const stages = rangeAnswerSelectionStages({
    ranked: ranked(plan.pool),
    rangeChunkIds: plan.rangeChunkIds,
    reservedEligibleChunkIds: plan.reservedEligibleChunkIds,
    reservedCount: input.reservedCount ?? DEFAULT_RESERVED_COUNT,
    maxPassages: input.maxPassages ?? DEFAULT_MAX_PASSAGES,
    minPassages: input.minPassages ?? DEFAULT_MIN_PASSAGES,
  });
  return { plan, selected: new PromptContextSelectorService(100_000).selectInStages(stages) };
};

describe("composeRangeAnswerPool", () => {
  it("keeps the best candidates outside the range in the pool even when the range alone would fill it", () => {
    const rangeCandidates = Array.from({ length: 50 }, (_value, index) => inDecember(`range-${index}`));
    const general = [candidate("policy"), candidate("faq"), candidate("venue"), candidate("glossary"), candidate("history")];

    const plan = composeRangeAnswerPool({ rangeCandidates, generalCandidates: general, range: december, poolSize: 50, reservedCount: 4 });

    expect(plan.pool).toHaveLength(50);
    expect(ids(plan.pool).filter((chunkId) => !plan.rangeChunkIds.has(chunkId))).toEqual(["policy", "faq", "venue", "glossary"]);
  });

  it("treats a general candidate dated in the range as part of it, after the lookup's passages", () => {
    const plan = composeRangeAnswerPool({
      rangeCandidates: [inDecember("range-1")],
      generalCandidates: [candidate("policy"), inDecember("semantic-december"), inDecember("range-1")],
      range: december,
      poolSize: 10,
      reservedCount: 4,
    });

    expect(ids(plan.pool)).toEqual(["range-1", "semantic-december", "policy"]);
    expect([...plan.rangeChunkIds]).toEqual(["range-1", "semantic-december"]);
  });

  it("fills the pool with more candidates outside the range when the range runs short", () => {
    const plan = composeRangeAnswerPool({
      rangeCandidates: [inDecember("range-1")],
      generalCandidates: ["a", "b", "c", "d", "e", "f"].map((chunkId) => candidate(chunkId)),
      range: december,
      poolSize: 5,
      reservedCount: 2,
    });

    expect(ids(plan.pool)).toEqual(["range-1", "a", "b", "c", "d"]);
  });

  it("treats a passage overlapping the range's edge as within it, not dated elsewhere", () => {
    // Starts in November, runs into the requested December range: an overlap, not an outside date.
    const overlapping = candidate("overlap", { dateFrom: "2026-11-28", dateTo: "2026-12-02" });
    const plan = composeRangeAnswerPool({
      rangeCandidates: [],
      generalCandidates: [overlapping, candidate("policy")],
      range: december,
      poolSize: 10,
      reservedCount: 4,
    });

    expect(plan.rangeChunkIds.has("overlap")).toBe(true);
    expect(plan.reservedEligibleChunkIds.has("overlap")).toBe(false);
  });

  it("treats a dateFrom-only passage as that single day, dated elsewhere when it falls outside the range", () => {
    // The WordPress connector writes only `dateFrom` for a post's publish date
    // (`wordpressIngest.ts`); the platform reads that as the single day, same as
    // `positionInDateRange` and the date-aware retrieval trigger that backfills `date_to`
    // from `date_from` at the database level. A weekly post published 2026-11-30 is dated
    // entirely before the requested December range, not undated.
    const dateFromOnly = candidate("wordpress-post", { dateFrom: "2026-11-30" });
    const plan = composeRangeAnswerPool({
      rangeCandidates: [],
      generalCandidates: [dateFromOnly],
      range: december,
      poolSize: 10,
      reservedCount: 4,
    });

    expect(plan.reservedEligibleChunkIds.has("wordpress-post")).toBe(false);
  });

  it("treats a dateFrom-only passage dated inside the range as part of the range", () => {
    const dateFromOnly = candidate("wordpress-post-in-range", { dateFrom: "2026-12-15" });
    const plan = composeRangeAnswerPool({
      rangeCandidates: [],
      generalCandidates: [dateFromOnly],
      range: december,
      poolSize: 10,
      reservedCount: 4,
    });

    expect(plan.rangeChunkIds.has("wordpress-post-in-range")).toBe(true);
  });

  it("treats a passage with no date metadata at all as undated", () => {
    const noDates = candidate("no-dates", {});
    const unparseable = candidate("garbage-date", { dateFrom: "not-a-date", dateTo: "also-not-a-date" });
    const plan = composeRangeAnswerPool({
      rangeCandidates: [],
      generalCandidates: [noDates, unparseable],
      range: december,
      poolSize: 10,
      reservedCount: 4,
    });

    expect(plan.reservedEligibleChunkIds.has("no-dates")).toBe(true);
    expect(plan.reservedEligibleChunkIds.has("garbage-date")).toBe(true);
  });

  it("prefers undated candidates over dated-elsewhere ones for a tight outside pool share", () => {
    // The dated-elsewhere passage ranks ahead of the undated ones, as a digest for an
    // adjacent period often does, but the tight outside share still favors the undated ones.
    const digest = inNovember("november-digest");
    const general = [digest, candidate("policy"), candidate("faq"), candidate("venue"), candidate("glossary")];
    const plan = composeRangeAnswerPool({
      rangeCandidates: Array.from({ length: 50 }, (_value, index) => inDecember(`range-${index}`)),
      generalCandidates: general,
      range: december,
      poolSize: 50,
      reservedCount: 4,
    });

    const outsidePool = ids(plan.pool).filter((chunkId) => !plan.rangeChunkIds.has(chunkId));
    expect(outsidePool).toEqual(["policy", "faq", "venue", "glossary"]);
    expect(outsidePool).not.toContain("november-digest");
    expect(plan.reservedEligibleChunkIds.has("november-digest")).toBe(false);
  });

  // Regression: an earlier version of this fix reordered the *whole* outside group (undated
  // first) before slicing the pool, not just the reserve's own lead. With reranking off (the
  // production default), pool order is selection order, so that reorder could bury a
  // high-ranked dated-elsewhere candidate below a wall of low-ranked undated ones and cut it
  // from the pool entirely — even though the sparse-range fill (not the reserve) is exactly
  // where it belongs.
  it("keeps a high-ranked dated-elsewhere candidate in the pool, reachable by the sparse-range fill, behind a wall of low-ranked undated pages", () => {
    const nextPeriodEvents = [inNovember("event-1"), inNovember("event-2"), inNovember("event-3")];
    const lowRankedPages = Array.from({ length: 20 }, (_value, index) => candidate(`page-${index}`));
    const plan = composeRangeAnswerPool({
      rangeCandidates: [inDecember("range-1")],
      generalCandidates: [...nextPeriodEvents, ...lowRankedPages],
      range: december,
      poolSize: DEFAULT_POOL_SIZE,
      reservedCount: DEFAULT_RESERVED_COUNT,
    });

    expect(ids(plan.pool)).toEqual(expect.arrayContaining(["event-1", "event-2", "event-3"]));
  });
});

describe("range answer selection", () => {
  const select = (input: { rangeCount: number; outsideCount: number; rangeDocumentSize?: number }) => {
    const rangeCandidates = Array.from({ length: input.rangeCount }, (_value, index) =>
      inDecember(`range-${index}`, `range-doc-${Math.floor(index / (input.rangeDocumentSize ?? 1))}`));
    const general = Array.from({ length: input.outsideCount }, (_value, index) => candidate(`outside-${index}`));
    return composeAndSelect({ rangeCandidates, generalCandidates: general, poolSize: 50 }).selected;
  };

  it("reserves four passages outside a busy range and gives the range the rest, most relevant first", () => {
    const selected = select({ rangeCount: 40, outsideCount: 10 });

    expect(selected).toHaveLength(20);
    expect(ids(selected).filter((chunkId) => chunkId.startsWith("outside-"))).toEqual(["outside-0", "outside-1", "outside-2", "outside-3"]);
    expect(ids(selected).filter((chunkId) => chunkId.startsWith("range-")))
      .toEqual(Array.from({ length: 16 }, (_value, index) => `range-${index}`));
  });

  it("counts only the range passages the prompt can keep, and leaves the spare slots empty", () => {
    // Six events of three passages each: at two passages per document, twelve can be kept.
    const selected = select({ rangeCount: 18, outsideCount: 10, rangeDocumentSize: 3 });

    expect(ids(selected).filter((chunkId) => chunkId.startsWith("range-"))).toHaveLength(12);
    expect(ids(selected).filter((chunkId) => chunkId.startsWith("outside-"))).toHaveLength(4);
  });

  it("fills a sparse range's answer to the ordinary passage count", () => {
    const selected = select({ rangeCount: 2, outsideCount: 15 });

    expect(selected).toHaveLength(12);
    expect(ids(selected).filter((chunkId) => chunkId.startsWith("range-"))).toHaveLength(2);
  });

  // The issue's acceptance list, at the selection stage: a well-covered range keeps
  // dated-elsewhere passages out of the reserve; a sparse range still fills from them;
  // undated passages keep their reserved share regardless. Pool size 20 and reservedCount 4
  // match the production default (rerankTopK 5, dateRangeListingContextTopK 20) so none of
  // this hides behind a pool generous enough to fit everything regardless of the ordering.
  describe("undated vs. dated-elsewhere outside the range, at the default pool size", () => {
    it("keeps a dated-elsewhere passage out of a well-covered range's reserved slots, even outranking the undated ones", () => {
      const digest = inNovember("november-digest");
      const rangeCandidates = Array.from({ length: 40 }, (_value, index) => inDecember(`range-${index}`));
      const { selected } = composeAndSelect({
        rangeCandidates,
        generalCandidates: [digest, candidate("policy"), candidate("faq"), candidate("venue"), candidate("glossary")],
      });

      expect(ids(selected)).not.toContain("november-digest");
      expect(ids(selected).filter((chunkId) => ["policy", "faq", "venue", "glossary"].includes(chunkId)))
        .toEqual(["policy", "faq", "venue", "glossary"]);
    });

    it("fills a sparse range's answer with a dated-elsewhere passage when nothing undated is available", () => {
      const digest = inNovember("november-digest");
      const { selected } = composeAndSelect({
        rangeCandidates: Array.from({ length: 2 }, (_value, index) => inDecember(`range-${index}`)),
        generalCandidates: [digest],
      });

      expect(ids(selected)).toContain("november-digest");
      expect(selected).toHaveLength(3);
    });

    it("gives undated passages their reserved share even when a dated-elsewhere passage is also present", () => {
      const digest = inNovember("november-digest");
      const rangeCandidates = Array.from({ length: 40 }, (_value, index) => inDecember(`range-${index}`));
      const { selected } = composeAndSelect({
        rangeCandidates,
        generalCandidates: [candidate("policy"), digest, candidate("venue"), candidate("glossary"), candidate("faq")],
      });

      expect(ids(selected).filter((chunkId) => chunkId !== "november-digest" && !chunkId.startsWith("range-")))
        .toEqual(["policy", "venue", "glossary", "faq"]);
      expect(ids(selected)).not.toContain("november-digest");
    });

    // Finding 1 at the selection stage: a sparse range (one event) whose best outside matches
    // are three dated-elsewhere events from the next period, ranked above a wall of 12+
    // low-ranked undated pages. On main, all three next-period events reach the answer via the
    // sparse-range fill. Reordering the whole outside group for the reserve must not cut them
    // from the pool before the sparse-range fill gets a chance at them.
    it("still reaches a high-ranked dated-elsewhere event through the sparse-range fill, past a wall of low-ranked undated pages", () => {
      const nextPeriodEvents = [inNovember("event-1"), inNovember("event-2"), inNovember("event-3")];
      const lowRankedPages = Array.from({ length: 12 }, (_value, index) => candidate(`page-${index}`));
      const { selected } = composeAndSelect({
        rangeCandidates: [inDecember("range-1")],
        generalCandidates: [...nextPeriodEvents, ...lowRankedPages],
      });

      expect(ids(selected)).toEqual(expect.arrayContaining(["event-1", "event-2", "event-3"]));
    });

    // Finding 2: a busy range (more events than the listing cap) whose only outside candidates
    // are dated elsewhere has nothing legitimate for the reserve. The range should reclaim that
    // capacity and reach the listing limit on its own, the same way it already does when there
    // are no outside candidates at all.
    it("lets a busy range reclaim the reserve and reach the listing limit when nothing outside it is undated", () => {
      const rangeCandidates = Array.from({ length: 30 }, (_value, index) => inDecember(`range-${index}`));
      const allDatedElsewhere = Array.from({ length: 10 }, (_value, index) => inNovember(`digest-${index}`));
      const { selected } = composeAndSelect({ rangeCandidates, generalCandidates: allDatedElsewhere });

      expect(selected).toHaveLength(DEFAULT_MAX_PASSAGES);
      expect(selected.every((context) => context.chunkId.startsWith("range-"))).toBe(true);
    });

    // A mix of both: the reserve takes what undated candidates exist, the range reclaims the
    // rest of what would have gone to dated-elsewhere ones, and nothing dated-elsewhere reaches
    // a well-covered range's answer.
    it("mixes a partial reserve with range reclaim when only some outside candidates are undated", () => {
      const rangeCandidates = Array.from({ length: 30 }, (_value, index) => inDecember(`range-${index}`));
      const undatedPages = [candidate("policy"), candidate("venue")];
      const datedElsewherePassages = Array.from({ length: 10 }, (_value, index) => inNovember(`digest-${index}`));
      const { selected } = composeAndSelect({
        rangeCandidates,
        generalCandidates: [...undatedPages, ...datedElsewherePassages],
      });

      expect(selected).toHaveLength(DEFAULT_MAX_PASSAGES);
      expect(ids(selected).filter((chunkId) => chunkId === "policy" || chunkId === "venue")).toEqual(["policy", "venue"]);
      expect(ids(selected).some((chunkId) => chunkId.startsWith("digest-"))).toBe(false);
    });
  });
});

describe("PromptContextSelectorService.selectInStages", () => {
  it("shares one token budget and per-document count across stages, each stopping at its own total", () => {
    const selector = new PromptContextSelectorService(100_000);
    const first = ranked([candidate("a", {}, "doc-shared"), candidate("b")]);
    const second = ranked([candidate("c", {}, "doc-shared"), candidate("d", {}, "doc-shared"), candidate("e")]);

    const selected = selector.selectInStages([
      { contexts: first, until: 1 },
      { contexts: second, until: 3 },
    ]);

    expect(ids(selected)).toEqual(["a", "e", "c"]);
  });

  it("selects one stage exactly as select does", () => {
    const selector = new PromptContextSelectorService(100_000);
    const contexts = ranked([candidate("a", {}, "doc-1"), candidate("b", {}, "doc-1"), candidate("c")]);

    expect(selector.selectInStages([{ contexts, until: 2 }])).toEqual(selector.select({ contexts, topK: 2 }));
  });
});
