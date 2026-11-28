import { describe, expect, it } from "vitest";

import { deriveLexicalQueryPlan } from "../../../src/modules/retrieval/domain/lexicalQueryPlan.js";
import { weighRelaxedLexicalHits } from "../../../src/modules/retrieval/domain/lexicalRelaxation.js";
import type { RetrievedChunk } from "../../../src/modules/retrieval/domain/vectorSearch.js";

const hit = (chunkId: string, lexicalRankScore: number, similarity: number): RetrievedChunk => ({
  chunkId,
  documentId: `doc-${chunkId}`,
  title: chunkId,
  content: chunkId,
  similarity,
  lexicalRankScore,
  lexicalTermCoverage: "all_terms",
});

const optionOf = (lexicalQuery: string, index: number) => {
  const option = deriveLexicalQueryPlan(lexicalQuery).options[index];
  if (!option) {
    throw new Error(`no alternative ${index} in ${lexicalQuery}`);
  }
  return option;
};

describe("relaxed lexical hits", () => {
  const planet = optionOf("Planet plan OR Planet", 1);

  it("keeps a hit under a heading that names the item as full evidence, and counts every other hit as a part match", () => {
    const headings: Record<string, string[]> = {
      help: ["Changing your Lumenfold plan"],
      section: ["Satellite", "Planet"],
      intro: ["Plans on Lumenfold Cloud"],
    };

    const weighed = weighRelaxedLexicalHits({
      option: planet,
      hits: [hit("help", 0.3, 1), hit("section", 0.15, 0.5), hit("intro", 0.2, 0.67)],
      headingsOf: (chunk) => headings[chunk.chunkId] ?? [],
    });

    expect(weighed.map(({ chunkId, lexicalTermCoverage, similarity }) => ({ chunkId, lexicalTermCoverage, similarity }))).toEqual([
      { chunkId: "section", lexicalTermCoverage: "all_terms", similarity: 1 },
      { chunkId: "help", lexicalTermCoverage: "some_terms", similarity: 0.5 },
      { chunkId: "intro", lexicalTermCoverage: "some_terms", similarity: 0.5 },
    ]);
  });

  it("does not take a heading that adds a word outside the phrase as naming the item", () => {
    const weighed = weighRelaxedLexicalHits({
      option: optionOf("Gold plan OR Gold", 1),
      hits: [hit("sponsor", 0.4, 1)],
      headingsOf: () => ["Gold sponsor"],
    });

    expect(weighed[0]?.lexicalTermCoverage).toBe("some_terms");
  });

  it("takes a heading holding the whole phrase as naming the item, in any script", () => {
    const weighed = weighRelaxedLexicalHits({
      option: optionOf("тариф Планета OR Планета", 1),
      hits: [hit("section", 0.4, 1)],
      headingsOf: () => ["Тариф Планета"],
    });

    expect(weighed[0]?.lexicalTermCoverage).toBe("all_terms");
  });

  it.each([
    "Planet — €579/mo",
    "Planet–€579 a month",
    "Planet: for growing teams",
    "Planet (Most popular)",
    "Planet | €579",
    "Planet - for growing teams",
    "3. Planet",
    "Planet 2031",
  ])("reads the name of the heading %j as the words before its first separator, numbers left out", (heading) => {
    const weighed = weighRelaxedLexicalHits({ option: planet, hits: [hit("section", 0.4, 1)], headingsOf: () => [heading] });

    expect(weighed[0]?.lexicalTermCoverage).toBe("all_terms");
  });

  it("reads a full-width separator as one", () => {
    const weighed = weighRelaxedLexicalHits({
      option: optionOf("行星 套餐 OR 行星", 1),
      hits: [hit("section", 0.4, 1)],
      headingsOf: () => ["行星（最受欢迎）"],
    });

    expect(weighed[0]?.lexicalTermCoverage).toBe("all_terms");
  });

  it("keeps a hyphenated name whole, so a longer name is not the item's", () => {
    const weighed = weighRelaxedLexicalHits({ option: planet, hits: [hit("section", 0.4, 1)], headingsOf: () => ["Planet-Max"] });

    expect(weighed[0]?.lexicalTermCoverage).toBe("some_terms");
  });

  it("judges each heading alone: a bare item heading names the item under any parent heading", () => {
    const weighed = weighRelaxedLexicalHits({
      option: optionOf("Gold plan OR Gold", 1),
      hits: [hit("tier", 0.4, 1)],
      headingsOf: () => ["Sponsorship tiers", "Gold"],
    });

    expect(weighed[0]?.lexicalTermCoverage).toBe("all_terms");
  });

  it("counts every hit of a chunk without headings as a part match", () => {
    const weighed = weighRelaxedLexicalHits({ option: planet, hits: [hit("pdf-page", 0.4, 1)], headingsOf: () => [] });

    expect(weighed[0]?.lexicalTermCoverage).toBe("some_terms");
  });

  it("leaves the hits of an alternative that relaxes nothing as they are", () => {
    const hits = [hit("help", 0.3, 1)];

    expect(weighRelaxedLexicalHits({ option: optionOf("Planet plan OR Planet", 0), hits, headingsOf: () => [] })).toBe(hits);
  });
});
