import type { RetrievedChunk } from "../infra/vectorSearch.js";
import { buildRetrievalText } from "./embeddingService.js";
import type { RetrievedCandidate, RetrievalSource } from "../domain/retrievalPipelineTypes.js";

export class CandidatePreparationService {
  prepare(input: {
    original: RetrievedChunk[];
    rewritten: RetrievedChunk[];
  }): RetrievedCandidate[] {
    const byChunkId = new Map<string, RetrievedCandidate>();

    this.addSource(byChunkId, input.original, "original");
    this.addSource(byChunkId, input.rewritten, "rewritten");

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
        existing.similarity = Math.max(existing.similarity, row.similarity);
        continue;
      }

      target.set(row.chunkId, {
        ...row,
        retrievalSources: [source],
        retrievalText: buildRetrievalText({
          title: row.title,
          content: row.content,
        }),
      });
    }
  }
}
