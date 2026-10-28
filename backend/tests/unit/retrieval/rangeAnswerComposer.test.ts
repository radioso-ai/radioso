import { describe, expect, it } from "vitest";

import type { RerankedCandidate, RetrievedCandidate } from "../../../src/modules/retrieval/domain/retrievalPipelineTypes.js";
import { PromptContextSelectorService } from "../../../src/modules/retrieval/services/promptContextSelectorService.js";
import {
  composeRangeAnswerPool,
  rangeAnswerSelectionStages,
} from "../../../src/modules/retrieval/services/temporal/rangeAnswerComposer.js";

const december = { dateFrom: "2026-12-01", dateTo: "2026-12-31" };

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
const ranked = (candidates: RetrievedCandidate[]): RerankedCandidate[] =>
  candidates.map((entry, index) => ({ ...entry, relevanceScore: 1 - index / 100, rerankPosition: index }));
const ids = (entries: Array<{ chunkId: string }>) => entries.map((entry) => entry.chunkId);

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

  it("treats an open-ended date (only one of dateFrom/dateTo known) as undated, not dated elsewhere", () => {
    const openStart = candidate("open-start", { dateFrom: "2026-01-01" });
    const openEnd = candidate("open-end", { dateTo: "2026-02-01" });
    const plan = composeRangeAnswerPool({
      rangeCandidates: [],
      generalCandidates: [openStart, openEnd],
      range: december,
      poolSize: 10,
      reservedCount: 4,
    });

    expect(plan.reservedEligibleChunkIds.has("open-start")).toBe(true);
    expect(plan.reservedEligibleChunkIds.has("open-end")).toBe(true);
  });

  it("treats an unparseable date as undated, not dated elsewhere", () => {
    const unparseable = candidate("garbage-date", { dateFrom: "not-a-date", dateTo: "also-not-a-date" });
    const plan = composeRangeAnswerPool({
      rangeCandidates: [],
      generalCandidates: [unparseable],
      range: december,
      poolSize: 10,
      reservedCount: 4,
    });

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
});

describe("range answer selection", () => {
  const select = (input: { rangeCount: number; outsideCount: number; rangeDocumentSize?: number }) => {
    const rangeCandidates = Array.from({ length: input.rangeCount }, (_value, index) =>
      inDecember(`range-${index}`, `range-doc-${Math.floor(index / (input.rangeDocumentSize ?? 1))}`));
    const general = Array.from({ length: input.outsideCount }, (_value, index) => candidate(`outside-${index}`));
    const plan = composeRangeAnswerPool({ rangeCandidates, generalCandidates: general, range: december, poolSize: 50, reservedCount: 4 });
    const stages = rangeAnswerSelectionStages({
      ranked: ranked(plan.pool),
      rangeChunkIds: plan.rangeChunkIds,
      reservedEligibleChunkIds: plan.reservedEligibleChunkIds,
      reservedCount: 4,
      maxPassages: 20,
      minPassages: 12,
    });
    return new PromptContextSelectorService(100_000).selectInStages(stages);
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
  // undated passages keep their reserved share regardless.
  describe("undated vs. dated-elsewhere outside the range", () => {
    const run = (input: { rangeCount: number; outside: RetrievedCandidate[] }) => {
      const rangeCandidates = Array.from({ length: input.rangeCount }, (_value, index) => inDecember(`range-${index}`));
      const plan = composeRangeAnswerPool({
        rangeCandidates,
        generalCandidates: input.outside,
        range: december,
        poolSize: 50,
        reservedCount: 4,
      });
      const stages = rangeAnswerSelectionStages({
        ranked: ranked(plan.pool),
        rangeChunkIds: plan.rangeChunkIds,
        reservedEligibleChunkIds: plan.reservedEligibleChunkIds,
        reservedCount: 4,
        maxPassages: 20,
        minPassages: 12,
      });
      return new PromptContextSelectorService(100_000).selectInStages(stages);
    };

    it("keeps a dated-elsewhere passage out of a well-covered range's reserved slots, even outranking the undated ones", () => {
      const digest = inNovember("november-digest");
      const selected = run({
        rangeCount: 40,
        outside: [digest, candidate("policy"), candidate("faq"), candidate("venue"), candidate("glossary")],
      });

      expect(ids(selected)).not.toContain("november-digest");
      expect(ids(selected).filter((chunkId) => ["policy", "faq", "venue", "glossary"].includes(chunkId)))
        .toEqual(["policy", "faq", "venue", "glossary"]);
    });

    it("fills a sparse range's answer with a dated-elsewhere passage when nothing undated is available", () => {
      const digest = inNovember("november-digest");
      const selected = run({ rangeCount: 2, outside: [digest] });

      expect(ids(selected)).toContain("november-digest");
      expect(selected).toHaveLength(3);
    });

    it("gives undated passages their reserved share even when a dated-elsewhere passage is also present", () => {
      const digest = inNovember("november-digest");
      const selected = run({
        rangeCount: 40,
        outside: [candidate("policy"), digest, candidate("venue"), candidate("glossary"), candidate("faq")],
      });

      expect(ids(selected).filter((chunkId) => chunkId !== "november-digest" && !chunkId.startsWith("range-")))
        .toEqual(["policy", "venue", "glossary", "faq"]);
      expect(ids(selected)).not.toContain("november-digest");
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
