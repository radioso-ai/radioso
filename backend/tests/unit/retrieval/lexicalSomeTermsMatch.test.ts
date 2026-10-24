import { describe, expect, it } from "vitest";

import { buildPlainLexicalQueryPlan, deriveLexicalQueryPlan } from "../../../src/modules/retrieval/domain/lexicalQueryPlan.js";
import {
  buildSomeTermsLexicalQuery,
  planSomeTermsRanking,
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
    matchCap: number;
    rankedChunkBudget: number;
    minimumWeightShare: number;
    maxRankedTerms: number;
  }> = {}) =>
    planSomeTermsRanking({
      query: queryFor(lexicalQuery),
      alternativeMatchCounts,
      matchCap: 200,
      rankedChunkBudget: 1000,
      minimumWeightShare: 1 / 3,
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

  it("weighs a rare term above a common one", () => {
    // preventivo, completo, pernottamento, evento, then the three joins.
    const plan = planFor("preventivo completo pernottamento evento", [30, 150, 4, 201, 0, 0, 0]);

    const [preventivo, completo, pernottamento, evento] = plan.termWeights;
    expect(pernottamento).toBeGreaterThan(preventivo);
    expect(preventivo).toBeGreaterThan(completo);
    expect(completo).toBeGreaterThan(evento);
    expect(plan.totalWeight).toBeCloseTo(plan.termWeights.reduce((sum, weight) => sum + weight, 0));
    expect(plan.everyTermRanked).toBe(true);
  });

  it("leaves a term found nowhere out of the weight a chunk is measured against", () => {
    const plan = planFor("preventivo completo pernottamento evento", [0, 150, 4, 201, 0, 0, 0]);

    expect(plan.termWeights[0]).toBe(0);
    expect(plan.totalWeight).toBeCloseTo(plan.termWeights[1] + plan.termWeights[2] + plan.termWeights[3]);
    // No chunk can hold a term that no chunk holds.
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

    expect(plan.minimumCoveredWeight).toBeGreaterThan(0);
    expect(plan.minimumCoveredWeight).toBeLessThanOrEqual(plan.totalWeight / 3);
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
