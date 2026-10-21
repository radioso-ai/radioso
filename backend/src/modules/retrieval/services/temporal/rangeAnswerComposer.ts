import type { RetrievedCandidate } from "../../domain/retrievalPipelineTypes.js";
import {
  datesFromMetadata,
  positionInDateRange,
  type RequestedDateRange,
} from "../../domain/temporal/requestedDateRange.js";

/**
 * The one place that decides what a requested-range answer is built from. The range's passages
 * (the lookup's, most similar to the question first, then any ranked candidate dated in the
 * range) and the best candidates outside the range (undated, or dated elsewhere, in their
 * semantic and lexical order) are two groups. The pool handed to reranking always holds the
 * first `reservedCount` candidates outside the range, the range fills the rest, and further
 * candidates outside it fill in when the range runs short.
 */
export const composeRangeAnswerPool = (input: {
  rangeCandidates: RetrievedCandidate[];
  generalCandidates: RetrievedCandidate[];
  range: RequestedDateRange;
  poolSize: number;
  reservedCount: number;
}): { pool: RetrievedCandidate[]; rangeChunkIds: ReadonlySet<string> } => {
  const lookupChunkIds = new Set(input.rangeCandidates.map((candidate) => candidate.chunkId));
  const datedInRange = (candidate: RetrievedCandidate): boolean =>
    positionInDateRange(datesFromMetadata(candidate.metadata), input.range) === "within";
  const rangeGroup = [
    ...input.rangeCandidates,
    ...input.generalCandidates.filter((candidate) => !lookupChunkIds.has(candidate.chunkId) && datedInRange(candidate)),
  ];
  const rangeChunkIds = new Set(rangeGroup.map((candidate) => candidate.chunkId));
  const outsideGroup = input.generalCandidates.filter((candidate) => !rangeChunkIds.has(candidate.chunkId));

  const reserveShare = Math.min(input.reservedCount, outsideGroup.length, input.poolSize);
  const rangeShare = Math.min(rangeGroup.length, input.poolSize - reserveShare);
  return {
    pool: [...rangeGroup.slice(0, rangeShare), ...outsideGroup.slice(0, input.poolSize - rangeShare)],
    rangeChunkIds,
  };
};

/**
 * The quotas the prompt selector applies to a ranked range-answer pool, in order: up to
 * `reservedCount` passages from outside the range, then the range's passages up to
 * `maxPassages` in all, then more passages from outside the range only to bring a sparse range's
 * answer up to `minPassages`. The selector's own limits (two passages per document, duplicates,
 * the token budget) decide how many of the range's passages fit, so the answer's size is what it
 * can actually keep.
 */
export const rangeAnswerSelectionStages = <T extends { chunkId: string }>(input: {
  ranked: T[];
  rangeChunkIds: ReadonlySet<string>;
  reservedCount: number;
  maxPassages: number;
  minPassages: number;
}): Array<{ contexts: T[]; until: number }> => {
  const range = input.ranked.filter((context) => input.rangeChunkIds.has(context.chunkId));
  const outside = input.ranked.filter((context) => !input.rangeChunkIds.has(context.chunkId));
  return [
    { contexts: outside, until: input.reservedCount },
    { contexts: range, until: input.maxPassages },
    { contexts: outside, until: input.minPassages },
  ];
};
