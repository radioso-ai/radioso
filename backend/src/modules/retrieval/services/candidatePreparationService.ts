import type { RetrievedChunk } from "../infra/vectorSearch.js";
import { buildRetrievalText } from "./embeddingService.js";
import { emptyStructuredAttributes } from "../domain/structuredAttributes.js";
import type { RetrievedCandidate, RetrievalSource } from "../domain/retrievalPipelineTypes.js";

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

    return [...byChunkId.values()].sort((a, b) => b.similarity - a.similarity);
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
        } else {
          existing.semanticScore = Math.max(existing.semanticScore, row.similarity);
        }
        existing.similarity = this.mergeScore(existing.semanticScore, existing.lexicalScore);
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
        similarity: this.mergeScore(semanticScore, lexicalScore),
        structuredAttributes: row.structuredAttributes ?? emptyStructuredAttributes(),
        attributeMatchScore: 0,
      });
    }
  }

  private mergeScore(semanticScore: number, lexicalScore: number): number {
    const primary = Math.max(semanticScore, lexicalScore);
    const secondary = Math.min(semanticScore, lexicalScore);
    return primary + secondary * 0.25;
  }
}
