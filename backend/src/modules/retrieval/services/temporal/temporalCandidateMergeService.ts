import type {
  RetrievedCandidate,
  RetrievalSource,
  TemporalQueryMode,
} from "../../domain/retrievalPipelineTypes.js";
import type { RetrievedChunk } from "../../domain/vectorSearch.js";
import { buildRetrievalText } from "../searchTextRenderer.js";
import { clampNormalizedScore } from "../candidateScoring.js";

const TEMPORAL_SOURCE: RetrievalSource = "temporal";

/**
 * Where structured temporal candidates go among the ranked ones: `lead` puts them first, in
 * the lookup's order, adding the ones search missed; `annotate` only marks ranked candidates
 * the lookup also found.
 */
type TemporalCandidatePlacement = "lead" | "annotate" | "none";

/**
 * A requested range's candidates lead whatever the rewrite labelled the question: they are the
 * passages dated in the period it names, closest to the question first. Without a range, an
 * upcoming listing's candidates lead and a topic question's only annotate.
 */
export const temporalCandidatePlacement = (input: {
  mode: TemporalQueryMode;
  requestedRangeLookup: boolean;
}): TemporalCandidatePlacement => {
  if (input.requestedRangeLookup || input.mode === "listing") {
    return "lead";
  }
  return input.mode === "topic_refinement" ? "annotate" : "none";
};

export const mergeTemporalCandidates = (input: {
  placement: TemporalCandidatePlacement;
  temporalCandidates: RetrievedChunk[];
  rankedCandidates: RetrievedCandidate[];
}): RetrievedCandidate[] => {
  if (input.placement === "none" || input.temporalCandidates.length === 0) {
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

    if (input.placement === "lead") {
      byChunkId.set(temporalCandidate.chunkId, toTemporalCandidate(temporalCandidate));
    }
  }

  if (input.placement === "annotate") {
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
