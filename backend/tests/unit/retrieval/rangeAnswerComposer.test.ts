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
