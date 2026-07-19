import type {
  RetrievedCandidate,
  RetrievalSource,
  TemporalQueryMode,
} from "../../domain/retrievalPipelineTypes.js";
import type { RetrievedChunk } from "../../domain/vectorSearch.js";
import { buildRetrievalText } from "../embeddingService.js";
import { clampNormalizedScore } from "../candidateScoring.js";

const TEMPORAL_SOURCE: RetrievalSource = "temporal";

export const mergeTemporalCandidates = (input: {
  mode: TemporalQueryMode;
  temporalCandidates: RetrievedChunk[];
  rankedCandidates: RetrievedCandidate[];
}): RetrievedCandidate[] => {
  if (input.mode === "none" || input.temporalCandidates.length === 0) {
    return input.rankedCandidates;
  }

  const byChunkId = new Map(input.rankedCandidates.map((candidate) => [candidate.chunkId, { ...candidate }]));
  const temporalCandidateIds = new Set(input.temporalCandidates.map((candidate) => candidate.chunkId));

  for (const temporalCandidate of input.temporalCandidates) {
    const existing = byChunkId.get(temporalCandidate.chunkId);
    if (existing) {
      byChunkId.set(temporalCandidate.chunkId, addTemporalSource(existing));
      continue;
    }

    if (input.mode === "listing") {
      byChunkId.set(temporalCandidate.chunkId, toTemporalCandidate(temporalCandidate));
    }
  }

  if (input.mode === "topic_refinement") {
    return input.rankedCandidates.map((candidate) =>
      temporalCandidateIds.has(candidate.chunkId) ? byChunkId.get(candidate.chunkId) ?? candidate : candidate,
    );
  }

  const orderedTemporalCandidates = input.temporalCandidates
    .map((candidate) => byChunkId.get(candidate.chunkId))
    .filter((candidate): candidate is RetrievedCandidate => Boolean(candidate));
  const temporalIds = new Set(orderedTemporalCandidates.map((candidate) => candidate.chunkId));
  const remainingRankedCandidates = input.rankedCandidates
    .filter((candidate) => !temporalIds.has(candidate.chunkId))
    .map((candidate) => byChunkId.get(candidate.chunkId) ?? candidate);

  return [...orderedTemporalCandidates, ...remainingRankedCandidates];
};

const addTemporalSource = (candidate: RetrievedCandidate): RetrievedCandidate => ({
  ...candidate,
  retrievalSources: candidate.retrievalSources.includes(TEMPORAL_SOURCE)
    ? candidate.retrievalSources
    : [...candidate.retrievalSources, TEMPORAL_SOURCE],
});

const toTemporalCandidate = (chunk: RetrievedChunk): RetrievedCandidate => {
  const fusedScore = clampNormalizedScore(chunk.similarity);
  return {
    ...chunk,
    retrievalSources: [TEMPORAL_SOURCE],
    retrievalText:
      chunk.searchText ??
      buildRetrievalText({
        title: chunk.title,
        content: chunk.content,
      }),
    semanticScore: 0,
    lexicalScore: 0,
    fusedScore,
    similarity: fusedScore,
    attributeMatchScore: 0,
  };
};
