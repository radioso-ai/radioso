import { RETRIEVAL_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";

/**
 * How many passages one answer prompt holds. An ordinary answer holds `finalContextTopK`. A
 * listing question whose structured lookup found passages in its requested date range holds one
 * per passage found, never fewer than `finalContextTopK` and never more than
 * `temporal.dateRangeListingContextTopK`: a busy week reaches the answer, and a day with two
 * events does not pull in eighteen passages from other dates. The prompt token budget bounds
 * every case.
 */
export const answerContextTopK = (answer: { requestedRangePassageCount?: number }): number =>
  Math.min(
    Math.max(answer.requestedRangePassageCount ?? 0, RETRIEVAL_BEHAVIOR.finalContextTopK),
    RETRIEVAL_BEHAVIOR.temporal.dateRangeListingContextTopK,
  );

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

/**
 * How many passages a requested-range lookup fetches: `temporal.dateRangeLookupDepth`, or more
 * when an operator-raised rerank top K gives the answer pool room for more.
 */
export const dateRangeLookupDepth = (rerankTopK: number): number =>
  Math.max(
    RETRIEVAL_BEHAVIOR.temporal.dateRangeLookupDepth,
    answerCandidatePoolSize(rerankTopK, RETRIEVAL_BEHAVIOR.temporal.dateRangeListingContextTopK),
  );
