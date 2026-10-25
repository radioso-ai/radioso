import { describe, expect, it } from "vitest";

import {
  compareByFusedScore,
  fuseCandidateRanks,
  hasUsefulCandidateEvidence,
} from "../../../src/modules/retrieval/services/candidateScoring.js";
import { CandidatePreparationService } from "../../../src/modules/retrieval/services/candidatePreparationService.js";
import { RETRIEVAL_BEHAVIOR } from "../../../src/shared/domain/behaviorConfig.js";
import type { RetrievedCandidate } from "../../../src/modules/retrieval/domain/retrievalPipelineTypes.js";
import type { RetrievedChunk } from "../../../src/modules/retrieval/domain/vectorSearch.js";

// Observed in production for an Italian kirtan query: these were the *top* lexical
// hits for the turn (lexicalScore 1) yet their absolute ts_rank_cd was far below the
// evidence floor, so the old shared gate zeroed their fused score entirely.
const PRODUCTION_TOP_LEXICAL_RANK_SCORE = 0.0142857;

const lexicalChunk = (input: {
  chunkId: string;
  lexicalScore: number;
  lexicalRankScore: number;
}): RetrievedChunk => ({
  chunkId: input.chunkId,
  documentId: `${input.chunkId}-doc`,
  title: input.chunkId,
  content: `content for ${input.chunkId}`,
  similarity: input.lexicalScore,
  lexicalRankScore: input.lexicalRankScore,
});

const semanticChunk = (input: { chunkId: string; similarity: number }): RetrievedChunk => ({
  chunkId: input.chunkId,
  documentId: `${input.chunkId}-doc`,
  title: input.chunkId,
  content: `content for ${input.chunkId}`,
  similarity: input.similarity,
});

const byChunkId = (candidates: RetrievedCandidate[], chunkId: string): RetrievedCandidate => {
  const found = candidates.find((candidate) => candidate.chunkId === chunkId);
  if (!found) {
    throw new Error(`expected candidate ${chunkId}`);
  }
  return found;
};

describe("fuseCandidateRanks lexical gate", () => {
  it("ranks that lexical-only hit above a semantic candidate at rank 2", () => {
    const lexicalOnly = fuseCandidateRanks({
      lexicalRank: 1,
      lexicalScore: 1,
    });
    const semanticRankTwo = fuseCandidateRanks({
      semanticRank: 2,
      lexicalScore: 0,
    });

    expect(lexicalOnly).toBeGreaterThan(semanticRankTwo);
  });

  it("gives no lexical contribution to a hit in the weak relative tail", () => {
    const belowThreshold = RETRIEVAL_BEHAVIOR.hybrid.lexicalFusionMinimumRelativeScore / 2;

    expect(
      fuseCandidateRanks({
        lexicalRank: 9,
        lexicalScore: belowThreshold,
      }),
    ).toBe(0);
  });

  it("admits a hit exactly at the relative fusion threshold", () => {
    expect(
      fuseCandidateRanks({
        lexicalRank: 1,
        lexicalScore: RETRIEVAL_BEHAVIOR.hybrid.lexicalFusionMinimumRelativeScore,
      }),
    ).toBeGreaterThan(0);
  });

  it("scores a candidate found by both branches above either branch alone", () => {
    const both = fuseCandidateRanks({ semanticRank: 3, lexicalRank: 1, lexicalScore: 1 });
    const lexicalOnly = fuseCandidateRanks({ lexicalRank: 1, lexicalScore: 1 });
    const semanticOnly = fuseCandidateRanks({ semanticRank: 3, lexicalScore: 0 });

    expect(both).toBeGreaterThan(lexicalOnly);
    expect(both).toBeGreaterThan(semanticOnly);
  });
});

describe("hasUsefulCandidateEvidence", () => {
  // The evidence gate answers a different question than the fusion gate: "is there any
  // real lexical signal at all?". It stays absolute, so it deliberately disagrees with
  // the fusion gate for a top hit on a weak query.
  it("still rejects the production top lexical hit as useful evidence", () => {
    expect(
      hasUsefulCandidateEvidence({
        semanticScore: 0,
        lexicalRankScore: PRODUCTION_TOP_LEXICAL_RANK_SCORE,
      }),
    ).toBe(false);
  });

  it("accepts a candidate at the absolute evidence floor", () => {
    expect(
      hasUsefulCandidateEvidence({
        semanticScore: 0,
        lexicalRankScore: RETRIEVAL_BEHAVIOR.hybrid.lexicalMinimumUsefulRankScore,
      }),
    ).toBe(true);
  });

  it("accepts any candidate with semantic evidence", () => {
    expect(hasUsefulCandidateEvidence({ semanticScore: 0.01, lexicalRankScore: 0 })).toBe(true);
  });
});

describe("CandidatePreparationService fusion wiring", () => {
  it("keeps the top lexical hits rankable when their absolute rank score is tiny", () => {
    const prepared = new CandidatePreparationService().prepare({
      original: [],
      rewritten: [
        semanticChunk({ chunkId: "semantic-1", similarity: 0.42 }),
        semanticChunk({ chunkId: "semantic-2", similarity: 0.4 }),
      ],
      lexical: [
        lexicalChunk({ chunkId: "narada-1", lexicalScore: 1, lexicalRankScore: PRODUCTION_TOP_LEXICAL_RANK_SCORE }),
        lexicalChunk({ chunkId: "narada-2", lexicalScore: 0.9, lexicalRankScore: 0.0128571 }),
        lexicalChunk({ chunkId: "weak-tail", lexicalScore: 0.05, lexicalRankScore: 0.0007 }),
      ],
    });

    const narada = byChunkId(prepared, "narada-1");
    expect(narada.fusedScore).toBeGreaterThan(0);
    expect(narada.similarity).toBe(narada.fusedScore);
    expect(byChunkId(prepared, "weak-tail").fusedScore).toBe(0);

    const order = prepared.map((candidate) => candidate.chunkId);
    expect(order.indexOf("narada-1")).toBeLessThan(order.indexOf("semantic-2"));
    expect(order.at(-1)).toBe("weak-tail");
  });
});

describe("compareByFusedScore", () => {
  it("orders by fused score before falling back to semantic score", () => {
    const strong = { fusedScore: 0.8, semanticScore: 0, lexicalRankScore: 0, lexicalScore: 1 } as RetrievedCandidate;
    const weak = { fusedScore: 0.5, semanticScore: 0.9, lexicalRankScore: 0, lexicalScore: 0 } as RetrievedCandidate;

    expect([weak, strong].sort(compareByFusedScore).map((candidate) => candidate.fusedScore)).toEqual([0.8, 0.5]);
  });
});

// A some-terms lexical hit holds part of the query, not all of it (#1576). It may lift a
// candidate another source found, but every verdict that reads a lexical hit as "the
// chunk contains what was asked for" must keep ignoring it.
describe("some-terms lexical matches", () => {
  const someTermsChunk = (chunkId: string, lexicalRankScore: number): RetrievedChunk => ({
    ...lexicalChunk({ chunkId, lexicalScore: 0.9, lexicalRankScore }),
    lexicalTermCoverage: "some_terms",
  });

  it("never count as useful lexical evidence", () => {
    const candidate = { semanticScore: 0, lexicalRankScore: 0.8 };

    expect(hasUsefulCandidateEvidence({ ...candidate, lexicalTermCoverage: "some_terms" })).toBe(false);
    expect(hasUsefulCandidateEvidence({ ...candidate, lexicalTermCoverage: "all_terms" })).toBe(true);
    expect(hasUsefulCandidateEvidence(candidate)).toBe(true);
    expect(hasUsefulCandidateEvidence({ semanticScore: 0.4, lexicalRankScore: 0.8, lexicalTermCoverage: "some_terms" })).toBe(true);
  });

  it("only corroborate in fusion: alone they rank below semantic hits", () => {
    const someTermsAlone = fuseCandidateRanks({ lexicalRank: 1, lexicalScore: 1, lexicalTermCoverage: "some_terms" });
    const allTermsAlone = fuseCandidateRanks({ lexicalRank: 1, lexicalScore: 1, lexicalTermCoverage: "all_terms" });
    const semanticRankFifty = fuseCandidateRanks({ semanticRank: 50, lexicalScore: 0 });

    expect(someTermsAlone).toBeGreaterThan(0);
    expect(someTermsAlone).toBeLessThan(semanticRankFifty);
    expect(allTermsAlone).toBeGreaterThan(semanticRankFifty);
  });

  it("lift a semantic hit they corroborate, by less than an all-terms match would", () => {
    const semanticOnly = fuseCandidateRanks({ semanticRank: 10, lexicalScore: 0 });
    const withSomeTerms = fuseCandidateRanks({ semanticRank: 10, lexicalRank: 1, lexicalScore: 1, lexicalTermCoverage: "some_terms" });
    const withAllTerms = fuseCandidateRanks({ semanticRank: 10, lexicalRank: 1, lexicalScore: 1, lexicalTermCoverage: "all_terms" });

    expect(withSomeTerms).toBeGreaterThan(semanticOnly);
    expect(withSomeTerms).toBeLessThan(withAllTerms);
  });

  it("take lexical ranks only after every all-terms hit", () => {
    const prepared = new CandidatePreparationService().prepare({
      original: [],
      rewritten: [],
      lexical: [
        someTermsChunk("partial", 0.9),
        { ...lexicalChunk({ chunkId: "exact", lexicalScore: 1, lexicalRankScore: 0.01 }), lexicalTermCoverage: "all_terms" },
      ],
    });

    expect(byChunkId(prepared, "exact").lexicalRank).toBe(1);
    expect(byChunkId(prepared, "partial").lexicalRank).toBe(2);
    expect(prepared.map((candidate) => candidate.chunkId)).toEqual(["exact", "partial"]);
  });

  it("give way to an all-terms match of the same chunk from another branch", () => {
    const prepared = new CandidatePreparationService().prepare({
      original: [],
      rewritten: [],
      lexical: [
        someTermsChunk("shared", 0.9),
        { ...lexicalChunk({ chunkId: "shared", lexicalScore: 1, lexicalRankScore: 0.2 }), lexicalTermCoverage: "all_terms" },
      ],
    });

    // The all-terms row's scores stand; the partial row's higher OR-query rank is ignored.
    expect(byChunkId(prepared, "shared")).toMatchObject({
      lexicalTermCoverage: "all_terms",
      lexicalScore: 1,
      lexicalRankScore: 0.2,
    });
    expect(hasUsefulCandidateEvidence(byChunkId(prepared, "shared"))).toBe(true);
  });

  it("take a semantic candidate's coverage from the first lexical row that finds it", () => {
    const prepared = new CandidatePreparationService().prepare({
      original: [semanticChunk({ chunkId: "semantic", similarity: 0.7 })],
      rewritten: [],
      lexical: [someTermsChunk("semantic", 0.9)],
    });

    expect(byChunkId(prepared, "semantic")).toMatchObject({
      lexicalTermCoverage: "some_terms",
      retrievalSources: ["semantic_original", "lexical"],
    });
  });
});
