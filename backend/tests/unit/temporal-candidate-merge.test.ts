import { describe, expect, it } from "vitest";

import { mergeTemporalCandidates } from "../../src/modules/retrieval/services/temporal/temporalCandidateMergeService.js";
import type { RetrievedCandidate } from "../../src/modules/retrieval/domain/retrievalPipelineTypes.js";
import type { RetrievedChunk } from "../../src/modules/retrieval/domain/vectorSearch.js";

const chunk = (chunkId: string, similarity: number, metadata: Record<string, unknown> = {}): RetrievedChunk => ({
  chunkId,
  documentId: `doc-${chunkId}`,
  title: `Document ${chunkId}`,
  content: `Content ${chunkId}`,
  searchText: `Search ${chunkId}`,
  similarity,
  chunkIndex: 0,
  startOffset: 0,
  endOffset: 10,
  metadata,
});

const candidate = (chunkId: string, similarity: number): RetrievedCandidate => ({
  ...chunk(chunkId, similarity),
  retrievalSources: ["semantic_rewritten"],
  retrievalText: `Search ${chunkId}`,
  semanticScore: similarity,
  lexicalScore: 0,
});

describe("mergeTemporalCandidates", () => {
  it("prepends temporal listing candidates in supplied temporal order and deduplicates existing candidates", () => {
    const result = mergeTemporalCandidates({
      mode: "listing",
      temporalCandidates: [
        chunk("future-soon", 0.01, { dateFrom: "2026-07-03" }),
        chunk("future-later", 0.01, { dateFrom: "2026-08-10" }),
      ],
      rankedCandidates: [
        candidate("future-later", 0.92),
        candidate("semantic-best", 0.99),
      ],
    });

    expect(result.map((entry) => entry.chunkId)).toEqual([
      "future-soon",
      "future-later",
      "semantic-best",
    ]);
    expect(result[1]?.retrievalSources).toEqual(["semantic_rewritten", "temporal"]);
    expect(result[1]?.semanticScore).toBe(0.92);
  });

  it("does not add temporal-only candidates in topic refinement mode", () => {
    const result = mergeTemporalCandidates({
      mode: "topic_refinement",
      temporalCandidates: [
        chunk("unrelated-upcoming", 0.01, { dateFrom: "2026-07-03" }),
        chunk("named-event", 0.01, { dateFrom: "2026-07-04" }),
      ],
      rankedCandidates: [
        candidate("named-event", 0.88),
        candidate("semantic-best", 0.84),
      ],
    });

    expect(result.map((entry) => entry.chunkId)).toEqual(["named-event", "semantic-best"]);
    expect(result[0]?.retrievalSources).toEqual(["semantic_rewritten", "temporal"]);
  });

  it("leaves ranked candidates unchanged when temporal mode is none", () => {
    const ranked = [candidate("semantic-best", 0.99)];

    const result = mergeTemporalCandidates({
      mode: "none",
      temporalCandidates: [chunk("future-soon", 0.01, { dateFrom: "2026-07-03" })],
      rankedCandidates: ranked,
    });

    expect(result).toEqual(ranked);
  });
});
