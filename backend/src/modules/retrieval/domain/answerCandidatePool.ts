import { RETRIEVAL_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";

/**
 * How many passages one answer prompt holds: `finalContextTopK`, or, for a listing question
 * whose structured lookup found events in a requested date range, the larger
 * `temporal.dateRangeListingContextTopK`, so a busy week reaches the answer. The prompt token
 * budget bounds both.
 */
export const answerContextTopK = (answer: { dateRangeListing: boolean }): number =>
  answer.dateRangeListing
    ? RETRIEVAL_BEHAVIOR.temporal.dateRangeListingContextTopK
    : RETRIEVAL_BEHAVIOR.finalContextTopK;

/**
 * How many fused candidates stay in play for the answer: at least enough to fill the answer's
 * prompt context target (`contextTopK`, by default `finalContextTopK`), raised further by the
 * operator's rerank top K, but never past the reranker's candidate limit. This is the single
 * pool size every later stage (reranking when enabled, or the fused order when it isn't) draws
 * from — raising `vectorTopK` alone cannot grow it.
 */
export const answerCandidatePoolSize = (
  rerankTopK: number,
  contextTopK: number = RETRIEVAL_BEHAVIOR.finalContextTopK,
): number =>
  Math.min(
    Math.max(rerankTopK, contextTopK),
    RETRIEVAL_BEHAVIOR.rerank.candidateLimit,
  );
