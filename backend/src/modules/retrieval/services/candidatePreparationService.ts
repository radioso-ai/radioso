import type { RetrievedChunk } from "../domain/vectorSearch.js";
import { buildRetrievalText } from "./searchTextRenderer.js";
import type { RetrievedCandidate, RetrievalSource } from "../domain/retrievalPipelineTypes.js";
import { compareByFusedScore, fuseCandidateRanks } from "./candidateScoring.js";

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

    const semanticRanks = this.buildSourceRanks([...input.original, ...input.rewritten], (row) => row.similarity);
    const lexicalRanks = this.buildSourceRanks(input.lexical, (row) => row.lexicalRankScore ?? 0);

    return [...byChunkId.values()]
      .map((candidate) => {
        const semanticRank = candidate.semanticScore > 0 ? semanticRanks.get(candidate.chunkId) : undefined;
        const lexicalRank = (candidate.lexicalRankScore ?? 0) > 0 ? lexicalRanks.get(candidate.chunkId) : undefined;
        const fusedScore = fuseCandidateRanks({
          semanticRank,
          lexicalRank,
          lexicalRankScore: candidate.lexicalRankScore ?? 0,
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
        if (!existing.retrievalSources.includes(source)) {
          existing.retrievalSources.push(source);
        }
        if (source === "lexical") {
          existing.lexicalScore = Math.max(existing.lexicalScore, row.similarity);
          existing.lexicalRankScore = Math.max(existing.lexicalRankScore ?? 0, row.lexicalRankScore ?? 0);
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

  private buildSourceRanks(rows: RetrievedChunk[], score: (row: RetrievedChunk) => number): Map<string, number> {
    const bestByChunkId = new Map<string, number>();
    for (const row of rows) {
      bestByChunkId.set(row.chunkId, Math.max(bestByChunkId.get(row.chunkId) ?? 0, score(row)));
    }

    return new Map(
      [...bestByChunkId.entries()]
        .sort(([leftId, leftScore], [rightId, rightScore]) => rightScore - leftScore || leftId.localeCompare(rightId))
        .map(([chunkId], index) => [chunkId, index + 1]),
    );
  }
}
