import { describe, expect, it } from "vitest";

import { buildPlainLexicalQueryPlan, deriveLexicalQueryPlan } from "../../../src/modules/retrieval/domain/lexicalQueryPlan.js";
import {
  buildSomeTermsLexicalQuery,
  planSomeTermsRanking,
  scoreSomeTermsCandidates,
  type SomeTermsLexicalQuery,
} from "../../../src/modules/retrieval/domain/lexicalSomeTermsMatch.js";

const queryFor = (lexicalQuery: string): SomeTermsLexicalQuery => {
  const query = buildSomeTermsLexicalQuery(buildPlainLexicalQueryPlan(lexicalQuery));
  if (!query) {
    throw new Error(`expected a some-terms query for ${lexicalQuery}`);
  }
  return query;
};

const textsOf = (query: SomeTermsLexicalQuery): string[] => query.alternatives.map((alternative) => alternative.text);

describe("buildSomeTermsLexicalQuery", () => {
  it("gives each query term its own alternative, in query order", () => {
    const query = queryFor("preventivo completo pernottamento evento");

    expect(query.termCount).toBe(4);
    expect(query.alternatives.slice(0, 4)).toEqual([
      { text: "preventivo", kind: "terms", covers: [0] },
      { text: "completo", kind: "terms", covers: [1] },
      { text: "pernottamento", kind: "terms", covers: [2] },
      { text: "evento", kind: "terms", covers: [3] },
    ]);
  });

  it("adds the join of each pair of adjacent terms, covering both terms", () => {
    const query = queryFor("super coscienti");

    expect(query.alternatives).toEqual([
      { text: "super", kind: "terms", covers: [0] },
      { text: "coscienti", kind: "terms", covers: [1] },
      { text: "supercoscienti", kind: "terms", covers: [0, 1] },
    ]);
  });

  it("splits terms at punctuation, elisions and hyphens, so each word is a term of its own", () => {
    const query = queryFor("dell'evento e-mail");

    expect(textsOf(query).slice(0, query.termCount)).toEqual(["dell", "evento", "e", "mail"]);
    expect(textsOf(query)).toContain("email");
  });

  it("keeps dotted numbers and identifiers whole", () => {
    const query = queryFor("versione 1.5 config_file");

    expect(textsOf(query).slice(0, query.termCount)).toEqual(["versione", "1.5", "config_file"]);
    // Joins only glue plain words; a dotted or underscored token keeps its own shape.
    expect(textsOf(query)).not.toContain("versione1.5");
  });

  it("counts a repeated term once, whatever its case", () => {
    const query = queryFor("Evento evento EVENTO corso");

    expect(query.termCount).toBe(2);
    expect(textsOf(query).slice(0, 2)).toEqual(["Evento", "corso"]);
  });

  it("merges a join that spells an existing term into that term's alternative", () => {
    const query = queryFor("super coscienti supercoscienti");

    expect(query.termCount).toBe(3);
    expect(query.alternatives.find((alternative) => alternative.text.toLowerCase() === "supercoscienti")?.covers)
      .toEqual([0, 1, 2]);
    expect(textsOf(query).filter((text) => text.toLowerCase() === "supercoscienti")).toHaveLength(1);
  });

  it("strips tsquery operators and quoting, so user text never becomes query syntax", () => {
    const query = queryFor("pernottamento & !evento | (super:* <-> coscienti) 'x' \\ \"y\" 7:A");

    for (const alternative of query.alternatives) {
      expect(alternative.text).toMatch(/^[\p{L}\p{M}\p{N}._]+$/u);
    }
    expect(textsOf(query).slice(0, query.termCount)).toEqual([
      "pernottamento",
      "evento",
      "super",
      "coscienti",
      "x",
      "y",
      "7",
      "A",
    ]);
  });

  it("returns no some-terms query when one term is all there is to match", () => {
    expect(buildSomeTermsLexicalQuery(buildPlainLexicalQueryPlan("Supercoscienti"))).toBeNull();
    expect(buildSomeTermsLexicalQuery(buildPlainLexicalQueryPlan("Supercoscienti?!"))).toBeNull();
    expect(buildSomeTermsLexicalQuery(buildPlainLexicalQueryPlan("--- &&"))).toBeNull();
  });

  it("treats quoted phrases as terms of their own and keeps exclusions", () => {
    const query = buildSomeTermsLexicalQuery(deriveLexicalQueryPlan('"reset token" expired -revoked'));

    expect(query).toEqual({
      termCount: 2,
      alternatives: [
        { text: "reset token", kind: "phrase", covers: [0] },
        { text: "expired", kind: "terms", covers: [1] },
      ],
      excludedTerms: ["revoked"],
      truncated: false,
    });
  });

  it("leaves a plan with explicit alternatives to its own strict options", () => {
    expect(buildSomeTermsLexicalQuery(deriveLexicalQueryPlan("reset token OR magic link"))).toBeNull();
  });

  it("keeps a long question's terms, and marks a query cut at the term limit", () => {
    const words = Array.from({ length: 40 }, (_, index) => `parola${index}`);

    const long = queryFor(words.slice(0, 20).join(" "));
    expect(long.termCount).toBe(20);
    expect(long.truncated).toBe(false);

    const cut = queryFor(words.join(" "));
    expect(cut.termCount).toBe(32);
    expect(cut.truncated).toBe(true);
    expect(textsOf(cut).slice(0, 32)).toEqual(words.slice(0, 32));
    expect(cut.alternatives.every((alternative) => alternative.covers.every((term) => term < 32))).toBe(true);
  });
});

describe("planSomeTermsRanking", () => {
  const rankingFor = (lexicalQuery: string, alternativeMatchCounts: number[], overrides: Partial<{
    scopeChunkCount: number;
    matchCap: number;
    rankedChunkBudget: number;
    minimumWeightShare: number;
    minimumHeldWeight: number;
    maxRankedTerms: number;
  }> = {}) =>
    planSomeTermsRanking({
      query: queryFor(lexicalQuery),
      alternativeMatchCounts,
      scopeChunkCount: 2_000,
      matchCap: 200,
      rankedChunkBudget: 1000,
      minimumWeightShare: 1 / 3,
      minimumHeldWeight: Math.log(10),
      maxRankedTerms: 12,
      ...overrides,
    });

  const planFor = (...args: Parameters<typeof rankingFor>) => {
    const plan = rankingFor(...args);
    if (!plan) {
      throw new Error("expected a ranking plan");
    }
    return plan;
  };

  it("weighs a term by how few of the workspace's chunks hold it", () => {
    // preventivo, completo, pernottamento, evento, then the three joins.
    const plan = planFor("preventivo completo pernottamento evento", [30, 150, 4, 190, 0, 0, 0]);

    const [preventivo, completo, pernottamento, evento] = plan.termWeights;
    expect(pernottamento).toBeCloseTo(Math.log(2_000 / 4));
    expect(preventivo).toBeCloseTo(Math.log(2_000 / 30));
    expect(completo).toBeCloseTo(Math.log(2_000 / 150));
    expect(evento).toBeCloseTo(Math.log(2_000 / 190));
    expect(plan.totalWeight).toBeCloseTo(plan.termWeights.reduce((sum, weight) => sum + weight, 0));
    expect(plan.everyTermRanked).toBe(true);
  });

  it("finds nothing when the only term found is common in the workspace", () => {
    // A small workspace: evento is on 150 of its 200 pages; nothing else in the query is.
    expect(rankingFor("preventivo costo parcheggio evento", [0, 0, 0, 150, 0, 0, 0], { scopeChunkCount: 200 })).toBeNull();
  });

  it("asks a chunk to hold an absolute amount of term weight as well as its share", () => {
    // completo is on 40 of 200 pages: a third of the query's weight, but not specific.
    const plan = planFor("completo pernottamento", [40, 2, 0], { scopeChunkCount: 200 });

    expect(plan.minimumCoveredWeight).toBeCloseTo(Math.log(10) * (1 - 1e-9));
    expect(plan.termWeights[0]).toBeLessThan(plan.minimumCoveredWeight);
    expect(plan.termWeights[1]).toBeGreaterThan(plan.minimumCoveredWeight);
  });

  it("leaves a term found nowhere out of the weight a chunk is measured against", () => {
    const plan = planFor("preventivo completo pernottamento evento", [0, 150, 4, 190, 0, 0, 0]);

    expect(plan.termWeights[0]).toBe(0);
    expect(plan.totalWeight).toBeCloseTo(plan.termWeights[1] + plan.termWeights[2] + plan.termWeights[3]);
    // No chunk can hold a term that no chunk holds.
    expect(plan.everyTermRanked).toBe(false);
  });

  it("gives a term too common to count no weight, rather than guessing one", () => {
    // evento passes the count cap: its real count is unknown, so it weighs nothing.
    const plan = planFor("pernottamento evento", [4, 201, 0]);

    expect(plan.termWeights[1]).toBe(0);
    expect(plan.totalWeight).toBeCloseTo(plan.termWeights[0]);
    expect(plan.everyTermRanked).toBe(false);
  });

  it("measures an English question against an Italian corpus by the one term the corpus holds", () => {
    // price, overnight, event, Supercoscienti, then the three joins.
    const plan = planFor("price overnight event Supercoscienti", [0, 0, 0, 1, 0, 0, 0]);

    expect(plan.termWeights.map((weight) => weight > 0)).toEqual([false, false, false, true]);
    expect(plan.totalWeight).toBeCloseTo(plan.termWeights[3]);
    expect(plan.matchingAlternatives).toEqual([3]);
    expect(plan.termWeights[3] >= plan.minimumCoveredWeight).toBe(true);
  });

  it("counts a term's matches through the joins that cover it", () => {
    // super, coscienti, supercoscienti: only the join is found.
    const plan = planFor("super coscienti", [60, 0, 1]);

    expect(plan.termWeights[1]).toBeGreaterThan(plan.termWeights[0]);
    expect(plan.matchingAlternatives).toEqual([2, 0]);
    expect(plan.scoredAlternatives).toEqual([0, 1, 2]);
  });

  it("lets only terms under the match cap define the chunks it ranks, rarest first", () => {
    const plan = planFor("preventivo completo pernottamento evento", [30, 150, 4, 201, 0, 2, 0]);

    // evento matches more than the cap; joins that match nothing add no chunks.
    expect(plan.matchingAlternatives).toEqual([5, 2, 0, 1]);
  });

  it("stops adding terms once their matches would pass the ranked-chunk budget", () => {
    const plan = planFor("alfa beta gamma", [150, 120, 90, 0, 0], { rankedChunkBudget: 250 });

    expect(plan.matchingAlternatives).toEqual([2, 1]);
  });

  it("ranks on the rarest terms when a question holds more than it ranks", () => {
    const words = Array.from({ length: 20 }, (_, index) => `parola${index}`);
    // The later the word, the rarer: parola19 is in 1 chunk, parola0 in 20.
    const counts = [...words.map((_, index) => 20 - index), ...Array.from({ length: 19 }, () => 0)];

    const plan = planFor(words.join(" "), counts);

    const ranked = plan.termWeights.flatMap((weight, term) => (weight > 0 ? [term] : []));
    expect(ranked).toEqual(Array.from({ length: 12 }, (_, index) => index + 8));
    expect(plan.scoredAlternatives.every((alternative) => alternative >= 8)).toBe(true);
    expect(plan.everyTermRanked).toBe(false);
  });

  it("asks a chunk to hold at least the configured share of the query's term weight", () => {
    const plan = planFor("alfa beta gamma", [10, 10, 10, 0, 0]);

    expect(plan.minimumCoveredWeight).toBeCloseTo(plan.totalWeight / 3 * (1 - 1e-9));
    // One of three equally weighted terms is exactly a third; rounding must not reject it.
    expect(plan.termWeights[0] >= plan.minimumCoveredWeight).toBe(true);
  });

  it("finds nothing to rank when every term is absent or too common", () => {
    expect(rankingFor("il di per", [201, 201, 201, 0, 0])).toBeNull();
    expect(rankingFor("alfa beta", [0, 0, 0])).toBeNull();
  });

  it("never treats a cut query as one a chunk can hold in full", () => {
    const words = Array.from({ length: 40 }, (_, index) => `parola${index}`);
    const counts = Array.from({ length: 32 + 31 }, (_, index) => (index < 32 ? 1 : 0));

    expect(planFor(words.join(" "), counts, { maxRankedTerms: 40 }).everyTermRanked).toBe(false);
  });
});

describe("scoreSomeTermsCandidates", () => {
  // Chunk ids named for what they hold; `filler` pads a list to give a term its count.
  const filler = (prefix: string, count: number): string[] => Array.from({ length: count }, (_, index) => `${prefix}-${index}`);

  const scoreFor = (lexicalQuery: string, alternativeChunkIds: Array<string[] | null>, overrides: Partial<{
    scopeChunkCount: number;
    rankedChunkBudget: number;
    minimumWeightShare: number;
    minimumHeldWeight: number;
  }> = {}) => {
    const query = queryFor(lexicalQuery);
    const ranking = planSomeTermsRanking({
      query,
      alternativeMatchCounts: alternativeChunkIds.map((ids) => ids?.length ?? 201),
      scopeChunkCount: 2_000,
      matchCap: 200,
      rankedChunkBudget: 1000,
      minimumWeightShare: 1 / 3,
      minimumHeldWeight: Math.log(10),
      maxRankedTerms: 12,
      ...overrides,
    });
    if (!ranking) {
      throw new Error("expected a ranking plan");
    }
    const candidates = scoreSomeTermsCandidates({ query, ranking, alternativeChunkIds });
    return { ranking, byChunk: new Map(candidates.map((candidate) => [candidate.chunkId, candidate])), candidates };
  };

  it("scores a chunk by the weight of every ranked term it holds", () => {
    // preventivo, completo, pernottamento, evento, then the three joins.
    const { ranking, byChunk } = scoreFor("preventivo completo pernottamento evento", [
      ["stay", ...filler("quote", 29)],
      filler("complete", 150),
      ["stay", "festival", "camp", "hostel"],
      ["stay", "festival", ...filler("event", 188)],
      [],
      [],
      [],
    ]);
    const [preventivo, , pernottamento, evento] = ranking.termWeights;

    // Summed in term order, so the weight is exactly what a sum over the terms gives.
    expect(byChunk.get("stay")?.coveredWeight).toBe((preventivo ?? 0) + (pernottamento ?? 0) + (evento ?? 0));
    expect(byChunk.get("festival")?.coveredWeight).toBe((pernottamento ?? 0) + (evento ?? 0));
  });

  it("drops chunks that hold too little of the query's term weight", () => {
    const { byChunk, ranking } = scoreFor("preventivo completo pernottamento evento", [
      ["stay", ...filler("quote", 29)],
      filler("complete", 150),
      ["stay", "festival", "camp", "hostel"],
      ["stay", "festival", ...filler("event", 188)],
      [],
      [],
      [],
    ]);

    // A chunk holding only evento, a word on 190 of 2,000 chunks, falls short of both floors.
    expect(ranking.termWeights[3]).toBeLessThan(ranking.minimumCoveredWeight);
    expect(byChunk.has("event-0")).toBe(false);
    expect([...byChunk.values()].every((candidate) => candidate.coveredWeight >= ranking.minimumCoveredWeight)).toBe(true);
  });

  it("ranks only chunks holding an alternative that defines the ranked set", () => {
    // gamma and beta fill the budget, so a chunk holding only alfa is never read, even with
    // the floors at zero.
    const { ranking, byChunk } = scoreFor("alfa beta gamma", [filler("alfa", 150), filler("beta", 120), filler("gamma", 90), [], []], {
      rankedChunkBudget: 250,
      minimumWeightShare: 0,
      minimumHeldWeight: 0,
    });

    expect(ranking.matchingAlternatives).toEqual([2, 1]);
    expect(byChunk.has("alfa-0")).toBe(false);
    expect(byChunk.has("beta-0")).toBe(true);
    expect(byChunk.has("gamma-0")).toBe(true);
  });

  it("counts a term held through a join, but only a term held by its own text toward holding every term", () => {
    // super, coscienti, supercoscienti.
    const { byChunk } = scoreFor("super coscienti", [
      ["both", ...filler("super", 59)],
      ["both", "coscienti-page"],
      ["joined"],
    ]);

    expect(byChunk.get("joined")).toMatchObject({ coversAllTerms: false });
    expect(byChunk.get("joined")?.coveredWeight).toBe(byChunk.get("both")?.coveredWeight);
    expect(byChunk.get("both")).toMatchObject({ coversAllTerms: true });
  });

  it("never tags a chunk as holding every term when a term is left out of the ranking", () => {
    // evento passes the count cap, so its list is not read.
    const { byChunk } = scoreFor("pernottamento evento", [["stay"], null, []]);

    expect(byChunk.get("stay")).toMatchObject({ coversAllTerms: false });
  });

  it("ranks a chunk against the texts of the alternatives it holds, in alternative order", () => {
    const { byChunk } = scoreFor("super coscienti", [
      ["both", ...filler("super", 59)],
      ["both", "coscienti-page"],
      ["both", "joined"],
    ]);

    expect(byChunk.get("both")?.heldText).toBe("super coscienti supercoscienti");
    expect(byChunk.get("joined")?.heldText).toBe("supercoscienti");
  });

  it("returns each chunk once, however many alternatives find it", () => {
    const { candidates } = scoreFor("super coscienti", [
      ["both", ...filler("super", 59)],
      ["both", "coscienti-page"],
      ["both", "joined"],
    ]);

    const ids = candidates.map((candidate) => candidate.chunkId);
    expect(ids).toHaveLength(new Set(ids).size);
  });
});
