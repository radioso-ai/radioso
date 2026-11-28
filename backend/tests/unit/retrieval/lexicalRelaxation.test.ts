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

  it("leaves the hits of an alternative that relaxes nothing as they are", () => {
    const hits = [hit("help", 0.3, 1)];

    expect(weighRelaxedLexicalHits({ option: optionOf("Planet plan OR Planet", 0), hits, headingsOf: () => [] })).toBe(hits);
  });
});
