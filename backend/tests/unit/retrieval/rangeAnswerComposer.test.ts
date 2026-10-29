import { describe, expect, it } from "vitest";

import type {
  RerankedCandidate,
  RetrievedCandidate,
  TemporalQueryMode,
} from "../../../src/modules/retrieval/domain/retrievalPipelineTypes.js";
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
// Dated entirely before the requested December range: a passage from a different period, such
// as an adjacent period's digest or an event in another month.
const inNovember = (chunkId: string, documentId?: string) =>
  candidate(chunkId, { dateFrom: "2026-11-10", dateTo: "2026-11-16" }, documentId);
// Pool order, tagged as already-ranked: how a reranked pool looks with reranking disabled
// (the production default), where the pool's own relevance order carries straight through.
const ranked = (candidates: RetrievedCandidate[]): RerankedCandidate[] =>
  candidates.map((entry, index) => ({ ...entry, relevanceScore: 1 - index / 1000, rerankPosition: index }));
const ids = (entries: Array<{ chunkId: string }>) => entries.map((entry) => entry.chunkId);
const rangeOf = (count: number) => Array.from({ length: count }, (_value, index) => inDecember(`range-${index}`));

type ComposeInput = Parameters<typeof composeRangeAnswerPool>[0];
type RangeAnswerPlan = ReturnType<typeof composeRangeAnswerPool>;

// Composes a listing question's pool at the production defaults unless a test says otherwise.
const compose = (input: Pick<ComposeInput, "rangeCandidates" | "generalCandidates"> & Partial<ComposeInput>) =>
  composeRangeAnswerPool({
    range: december,
    temporalQueryMode: "listing",
    poolSize: DEFAULT_POOL_SIZE,
    reservedCount: DEFAULT_RESERVED_COUNT,
    ...input,
  });
const poolIdsIn = (plan: RangeAnswerPlan, group: "range" | "reserved" | "outside") =>
  ids(plan.pool).filter((chunkId) => plan.groups.get(chunkId) === group);
const outsidePoolIds = (plan: RangeAnswerPlan) => ids(plan.pool).filter((chunkId) => plan.groups.get(chunkId) !== "range");

// Runs the composer and the selection stages together, as `contextSelectionStage.ts` does with
// reranking disabled, and returns the final selected contexts.
const composeAndSelect = (input: {
  rangeCandidates: RetrievedCandidate[];
  generalCandidates: RetrievedCandidate[];
  temporalQueryMode?: TemporalQueryMode;
  poolSize?: number;
}) => {
  const plan = compose(input);
  const stages = rangeAnswerSelectionStages({
    ranked: ranked(plan.pool),
    groups: plan.groups,
    maxPassages: DEFAULT_MAX_PASSAGES,
    minPassages: DEFAULT_MIN_PASSAGES,
  });
  return { plan, selected: new PromptContextSelectorService(100_000).selectInStages(stages) };
};

describe("composeRangeAnswerPool", () => {
  it("keeps the best candidates outside the range in the pool even when the range alone would fill it", () => {
    const general = [candidate("policy"), candidate("faq"), candidate("venue"), candidate("glossary"), candidate("history")];

    const plan = compose({ rangeCandidates: rangeOf(50), generalCandidates: general, poolSize: 50 });

    expect(plan.pool).toHaveLength(50);
    expect(outsidePoolIds(plan)).toEqual(["policy", "faq", "venue", "glossary"]);
    expect(poolIdsIn(plan, "reserved")).toEqual(["policy", "faq", "venue", "glossary"]);
  });

  it("treats a general candidate dated in the range as part of it, after the lookup's passages", () => {
    const plan = compose({
      rangeCandidates: [inDecember("range-1")],
      generalCandidates: [candidate("policy"), inDecember("semantic-december"), inDecember("range-1")],
      poolSize: 10,
    });

    expect(ids(plan.pool)).toEqual(["range-1", "semantic-december", "policy"]);
    expect(poolIdsIn(plan, "range")).toEqual(["range-1", "semantic-december"]);
  });

  it("fills the pool with more candidates outside the range when the range runs short", () => {
    const plan = compose({
      rangeCandidates: [inDecember("range-1")],
      generalCandidates: ["a", "b", "c", "d", "e", "f"].map((chunkId) => candidate(chunkId)),
      poolSize: 5,
      reservedCount: 2,
    });

    expect(ids(plan.pool)).toEqual(["range-1", "a", "b", "c", "d"]);
  });

  it("treats a passage overlapping the range's edge as within it, not dated elsewhere", () => {
    // Starts in November, runs into the requested December range: an overlap, not an outside date.
    const overlapping = candidate("overlap", { dateFrom: "2026-11-28", dateTo: "2026-12-02" });
    const plan = compose({ rangeCandidates: [], generalCandidates: [overlapping, candidate("policy")], poolSize: 10 });

    expect(plan.groups.get("overlap")).toBe("range");
  });

  it("treats a dateFrom-only passage as that single day, dated elsewhere when it falls outside the range", () => {
    // One known date is that single day, as `positionInDateRange` and the structured lookup's
    // date columns read it, so a post dated 2026-11-30 lies entirely before December.
    const dateFromOnly = candidate("single-date-post", { dateFrom: "2026-11-30" });
    const plan = compose({ rangeCandidates: [], generalCandidates: [dateFromOnly], poolSize: 10 });

    expect(plan.groups.get("single-date-post")).toBe("outside");
  });

  it("treats a dateFrom-only passage dated inside the range as part of the range", () => {
    const dateFromOnly = candidate("single-date-post-in-range", { dateFrom: "2026-12-15" });
    const plan = compose({ rangeCandidates: [], generalCandidates: [dateFromOnly], poolSize: 10 });

    expect(plan.groups.get("single-date-post-in-range")).toBe("range");
  });

  it("treats a passage with no date metadata at all as undated", () => {
    const noDates = candidate("no-dates", {});
    const unparseable = candidate("garbage-date", { dateFrom: "not-a-date", dateTo: "also-not-a-date" });
    const plan = compose({ rangeCandidates: [], generalCandidates: [noDates, unparseable], poolSize: 10 });

    expect(plan.groups.get("no-dates")).toBe("reserved");
    expect(plan.groups.get("garbage-date")).toBe("reserved");
  });

  it("gives a reserved slot a passage dated in another period would hold back to the range, not to an undated candidate ranked below the reserve", () => {
    // The digest ranks among the four best outside candidates, as a digest for an adjacent
    // period often does; its slot goes to the range, and the fifth-ranked page stays out.
    const general = [inNovember("november-digest"), candidate("policy"), candidate("faq"), candidate("venue"), candidate("glossary")];
    const plan = compose({ rangeCandidates: rangeOf(50), generalCandidates: general, poolSize: 50 });

    expect(outsidePoolIds(plan)).toEqual(["policy", "faq", "venue"]);
    expect(poolIdsIn(plan, "range")).toHaveLength(47);
    expect(plan.groups.get("november-digest")).toBe("outside");
  });

  it("keeps the outside candidates in their own relevance order in the pool, reserved or not", () => {
    // Reranking sees the pool as it is, and with reranking off it keeps this order, so the
    // reserve is a group of chunk ids, never a reordering.
    const general = [inNovember("event-1"), candidate("page-1"), inNovember("event-2"), candidate("page-2"), candidate("page-3")];
    const plan = compose({ rangeCandidates: [inDecember("range-1")], generalCandidates: general });

    expect(outsidePoolIds(plan)).toEqual(["event-1", "page-1", "event-2", "page-2", "page-3"]);
    expect(poolIdsIn(plan, "reserved")).toEqual(["page-1", "page-2"]);
  });

  it("keeps a high-ranked dated-elsewhere candidate in the pool, reachable by the sparse-range fill, behind a wall of low-ranked undated pages", () => {
    const nextPeriodEvents = [inNovember("event-1"), inNovember("event-2"), inNovember("event-3")];
    const lowRankedPages = Array.from({ length: 20 }, (_value, index) => candidate(`page-${index}`));
    const plan = compose({ rangeCandidates: [inDecember("range-1")], generalCandidates: [...nextPeriodEvents, ...lowRankedPages] });

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
  const outsideIds = (selected: Array<{ chunkId: string }>) => ids(selected).filter((chunkId) => !chunkId.startsWith("range-"));

  it("reserves four passages outside a busy range and gives the range the rest, most relevant first", () => {
    const selected = select({ rangeCount: 40, outsideCount: 10 });

    expect(selected).toHaveLength(20);
    expect(outsideIds(selected)).toEqual(["outside-0", "outside-1", "outside-2", "outside-3"]);
    expect(ids(selected).filter((chunkId) => chunkId.startsWith("range-")))
      .toEqual(Array.from({ length: 16 }, (_value, index) => `range-${index}`));
  });

  it("counts only the range passages the prompt can keep, and leaves the spare slots empty", () => {
    // Six events of three passages each: at two passages per document, twelve can be kept.
    const selected = select({ rangeCount: 18, outsideCount: 10, rangeDocumentSize: 3 });

    expect(ids(selected).filter((chunkId) => chunkId.startsWith("range-"))).toHaveLength(12);
    expect(outsideIds(selected)).toHaveLength(4);
  });

  it("fills a sparse range's answer to the ordinary passage count", () => {
    const selected = select({ rangeCount: 2, outsideCount: 15 });

    expect(selected).toHaveLength(12);
    expect(ids(selected).filter((chunkId) => chunkId.startsWith("range-"))).toHaveLength(2);
  });

  // The issue's acceptance list, at the selection stage and at the production pool size (20),
  // so nothing hides behind a pool generous enough to fit everything: a well-covered range
  // keeps dated-elsewhere passages out of the reserve, a sparse range still fills from them,
  // and undated passages keep their reserved share.
  describe("a listing question, at the default pool size", () => {
    it("keeps a dated-elsewhere passage out of a well-covered range's reserved slots, even outranking the undated ones", () => {
      const { selected } = composeAndSelect({
        rangeCandidates: rangeOf(40),
        generalCandidates: [inNovember("november-digest"), candidate("policy"), candidate("faq"), candidate("venue"), candidate("glossary")],
      });

      expect(selected).toHaveLength(DEFAULT_MAX_PASSAGES);
      expect(outsideIds(selected)).toEqual(["policy", "faq", "venue"]);
    });

    it("fills a sparse range's answer with a dated-elsewhere passage when nothing undated is available", () => {
      const { selected } = composeAndSelect({ rangeCandidates: rangeOf(2), generalCandidates: [inNovember("november-digest")] });

      expect(ids(selected)).toContain("november-digest");
      expect(selected).toHaveLength(3);
    });

    it("gives undated passages their reserved share even when a dated-elsewhere passage is also present", () => {
      const { selected } = composeAndSelect({
        rangeCandidates: rangeOf(40),
        generalCandidates: [candidate("policy"), inNovember("november-digest"), candidate("venue"), candidate("glossary"), candidate("faq")],
      });

      expect(selected).toHaveLength(DEFAULT_MAX_PASSAGES);
      expect(outsideIds(selected)).toEqual(["policy", "venue", "glossary"]);
    });

    it("still reaches a high-ranked dated-elsewhere event through the sparse-range fill, past a wall of low-ranked undated pages", () => {
      const nextPeriodEvents = [inNovember("event-1"), inNovember("event-2"), inNovember("event-3")];
      const lowRankedPages = Array.from({ length: 12 }, (_value, index) => candidate(`page-${index}`));
      const { selected } = composeAndSelect({ rangeCandidates: rangeOf(1), generalCandidates: [...nextPeriodEvents, ...lowRankedPages] });

      expect(ids(selected)).toEqual(expect.arrayContaining(["event-1", "event-2", "event-3"]));
    });

    it("lets a busy range reclaim the reserve and reach the listing limit when nothing outside it is undated", () => {
      const allDatedElsewhere = Array.from({ length: 10 }, (_value, index) => inNovember(`digest-${index}`));
      const { selected } = composeAndSelect({ rangeCandidates: rangeOf(30), generalCandidates: allDatedElsewhere });

      expect(selected).toHaveLength(DEFAULT_MAX_PASSAGES);
      expect(selected.every((context) => context.chunkId.startsWith("range-"))).toBe(true);
    });

    it("mixes a partial reserve with range reclaim when only some outside candidates are undated", () => {
      const datedElsewherePassages = Array.from({ length: 10 }, (_value, index) => inNovember(`digest-${index}`));
      const { selected } = composeAndSelect({
        rangeCandidates: rangeOf(30),
        generalCandidates: [candidate("policy"), candidate("venue"), ...datedElsewherePassages],
      });

      expect(selected).toHaveLength(DEFAULT_MAX_PASSAGES);
      expect(outsideIds(selected)).toEqual(["policy", "venue"]);
    });

    it("keeps undated pages ranked below the reserve out of a busy range's answer", () => {
      // The twenty best outside matches are dated elsewhere; an imprint or cookie page far down
      // the list matches the question too weakly to displace the range's own passages.
      const datedElsewhere = Array.from({ length: 20 }, (_value, index) => inNovember(`digest-${index}`));
      const deepPages = ["imprint", "cookies", "privacy", "sitemap"].map((chunkId) => candidate(chunkId));
      const { selected } = composeAndSelect({ rangeCandidates: rangeOf(40), generalCandidates: [...datedElsewhere, ...deepPages] });

      expect(selected).toHaveLength(DEFAULT_MAX_PASSAGES);
      expect(selected.every((context) => context.chunkId.startsWith("range-"))).toBe(true);
    });

    it("fills a sparse range from the best outside candidates in their own order, ahead of weaker undated pages", () => {
      // A day with two events: next week's ten events match strongly, ten undated pages weakly.
      const nextWeekEvents = Array.from({ length: 10 }, (_value, index) => inNovember(`event-${index}`));
      const weakPages = Array.from({ length: 10 }, (_value, index) => candidate(`page-${index}`));
      const { selected } = composeAndSelect({ rangeCandidates: rangeOf(2), generalCandidates: [...nextWeekEvents, ...weakPages] });

      expect(selected).toHaveLength(DEFAULT_MIN_PASSAGES);
      expect(new Set(outsideIds(selected))).toEqual(new Set(ids(nextWeekEvents)));
    });

    it("fills a sparse range with the same best outside candidates however undated and dated-elsewhere ones interleave", () => {
      const outside = Array.from({ length: 20 }, (_value, index) =>
        index % 2 === 0 ? inNovember(`event-${index}`) : candidate(`page-${index}`));
      const { selected } = composeAndSelect({ rangeCandidates: rangeOf(2), generalCandidates: outside });

      expect(new Set(outsideIds(selected))).toEqual(new Set(ids(outside.slice(0, 10))));
    });

    it("counts the reserve by what the answer can take, at most two passages per document", () => {
      // Four undated passages of one pricing document: the answer keeps two of them, so the
      // range takes the other two slots and the answer still reaches the listing limit.
      const pricing = Array.from({ length: 4 }, (_value, index) => candidate(`pricing-${index}`, {}, "doc-pricing"));
      const { selected } = composeAndSelect({ rangeCandidates: rangeOf(40), generalCandidates: pricing });

      expect(selected).toHaveLength(DEFAULT_MAX_PASSAGES);
      expect(outsideIds(selected)).toEqual(["pricing-0", "pricing-1"]);
    });
  });

  // A question about a named topic in the wrong period ("is the retreat in March?" when it is in
  // April) needs the topic's real date, even in a busy period.
  describe("a question about a named topic", () => {
    const retreatQuestionCandidates = () => [
      inNovember("retreat"),
      candidate("policy"),
      inDecember("december-class"),
      candidate("venue"),
    ];

    it("keeps the best match dated in another period in the reserve when search ranks it above everything in the range", () => {
      const { selected } = composeAndSelect({
        temporalQueryMode: "topic_refinement",
        rangeCandidates: rangeOf(40),
        generalCandidates: retreatQuestionCandidates(),
      });

      expect(selected).toHaveLength(DEFAULT_MAX_PASSAGES);
      expect(outsideIds(selected)).toEqual(["retreat", "policy", "venue"]);
    });

    it("gives a dated-elsewhere passage's slot back to the range when a passage in the range outranks it", () => {
      // The requested period's own digest ranks first, an adjacent period's digest after it.
      const { selected } = composeAndSelect({
        temporalQueryMode: "topic_refinement",
        rangeCandidates: rangeOf(40),
        generalCandidates: [inDecember("december-digest"), inNovember("november-digest"), candidate("policy")],
      });

      expect(selected).toHaveLength(DEFAULT_MAX_PASSAGES);
      expect(outsideIds(selected).filter((chunkId) => chunkId !== "december-digest")).toEqual(["policy"]);
    });

    it.each(["listing", "none"] as const)(
      "keeps a dated-elsewhere passage out of the reserve for a %s question, however search ranks it",
      (temporalQueryMode) => {
        const { selected } = composeAndSelect({
          temporalQueryMode,
          rangeCandidates: rangeOf(40),
          generalCandidates: retreatQuestionCandidates(),
        });

        expect(selected).toHaveLength(DEFAULT_MAX_PASSAGES);
        expect(outsideIds(selected).filter((chunkId) => chunkId !== "december-class")).toEqual(["policy", "venue"]);
      },
    );
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
