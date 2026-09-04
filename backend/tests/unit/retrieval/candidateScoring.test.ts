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
