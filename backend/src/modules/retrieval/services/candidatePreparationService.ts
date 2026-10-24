import { isSomeTermsLexicalMatch, type RetrievedChunk } from "../domain/vectorSearch.js";
import { buildRetrievalText } from "./searchTextRenderer.js";
import type { RetrievedCandidate, RetrievalSource } from "../domain/retrievalPipelineTypes.js";
import {
  compareByFusedScore,
  compareLexicalEvidence,
  fuseCandidateRanks,
} from "./candidateScoring.js";

export class CandidatePreparationService {
  prepare(input: {
    original: RetrievedChunk[];
    rewritten: RetrievedChunk[];
    lexical: RetrievedChunk[];
  }): RetrievedCandidate[] {
    const byChunkId = new Map<string, RetrievedCandidate>();

    this.addSource(byChunkId, input.original, "semantic_original");
    this.addSource(byChunkId, input.rewritten, "semantic_rewritten");
    this.addSource(byChunkId, input.lexical, "lexical");

    const semanticRanks = this.buildSourceRanks(
      [...input.original, ...input.rewritten],
      (left, right) => right.similarity - left.similarity,
    );
    const lexicalRanks = this.buildSourceRanks(input.lexical, compareLexicalEvidence);

    return [...byChunkId.values()]
      .map((candidate) => {
        const semanticRank = candidate.semanticScore > 0 ? semanticRanks.get(candidate.chunkId) : undefined;
        const lexicalRank = (candidate.lexicalRankScore ?? 0) > 0 ? lexicalRanks.get(candidate.chunkId) : undefined;
        const fusedScore = fuseCandidateRanks({
          semanticRank,
          lexicalRank,
          lexicalScore: candidate.lexicalScore,
          lexicalTermCoverage: candidate.lexicalTermCoverage,
        });
        return {
          ...candidate,
          semanticRank,
          lexicalRank,
          fusedScore,
          similarity: fusedScore,
        };
      })
      .sort(compareByFusedScore);
  }

  private addSource(
    target: Map<string, RetrievedCandidate>,
    rows: RetrievedChunk[],
    source: RetrievalSource,
  ) {
    for (const row of rows) {
      const existing = target.get(row.chunkId);
      if (existing) {
        const foundLexically = existing.retrievalSources.includes("lexical");
        if (!existing.retrievalSources.includes(source)) {
          existing.retrievalSources.push(source);
        }
        if (source === "lexical") {
          mergeLexicalRow(existing, row, foundLexically);
        } else {
          existing.semanticScore = Math.max(existing.semanticScore, row.similarity);
        }
        continue;
      }

      const semanticScore = source === "lexical" ? 0 : row.similarity;
      const lexicalScore = source === "lexical" ? row.similarity : 0;
      target.set(row.chunkId, {
        ...row,
        retrievalSources: [source],
        retrievalText:
          row.searchText ??
          buildRetrievalText({
            title: row.title,
            content: row.content,
          }),
        semanticScore,
        lexicalScore,
        lexicalRankScore: source === "lexical" ? row.lexicalRankScore ?? 0 : 0,
        similarity: 0,
        attributeMatchScore: 0,
      });
    }
  }

  // `compare` orders the stronger row first. A chunk found by several branches ranks
  // by its strongest row.
  private buildSourceRanks(
    rows: RetrievedChunk[],
    compare: (left: RetrievedChunk, right: RetrievedChunk) => number,
  ): Map<string, number> {
    const bestByChunkId = new Map<string, RetrievedChunk>();
    for (const row of rows) {
      const best = bestByChunkId.get(row.chunkId);
      if (!best || compare(row, best) < 0) {
        bestByChunkId.set(row.chunkId, row);
      }
    }

    return new Map(
      [...bestByChunkId.values()]
        .sort((left, right) => compare(left, right) || left.chunkId.localeCompare(right.chunkId))
        .map((row, index) => [row.chunkId, index + 1]),
    );
  }
}

// A candidate's lexical scores come from its strongest coverage: a branch that found
// every term replaces a partial match, and a partial match never dilutes a full one.
const mergeLexicalRow = (candidate: RetrievedCandidate, row: RetrievedChunk, foundLexically: boolean): void => {
  const replace = () => {
    candidate.lexicalScore = row.similarity;
    candidate.lexicalRankScore = row.lexicalRankScore ?? 0;
    candidate.lexicalTermCoverage = row.lexicalTermCoverage;
  };
  if (!foundLexically) {
    replace();
    return;
  }
  const candidateIsPartial = isSomeTermsLexicalMatch(candidate);
  if (candidateIsPartial !== isSomeTermsLexicalMatch(row)) {
    if (candidateIsPartial) {
      replace();
    }
    return;
  }
  candidate.lexicalScore = Math.max(candidate.lexicalScore, row.similarity);
  candidate.lexicalRankScore = Math.max(candidate.lexicalRankScore ?? 0, row.lexicalRankScore ?? 0);
};
