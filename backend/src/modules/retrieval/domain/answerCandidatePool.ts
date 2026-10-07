import { RETRIEVAL_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";

/**
 * How many fused candidates stay in play for the answer: at least enough to fill the final
 * prompt context target (`finalContextTopK`), raised further by the operator's rerank top K, but
 * never past the reranker's candidate limit. This is the single pool size every later stage
 * (reranking when enabled, or the fused order when it isn't) draws from — raising `vectorTopK`
 * alone cannot grow it.
 */
export const answerCandidatePoolSize = (rerankTopK: number): number =>
  Math.min(
    Math.max(rerankTopK, RETRIEVAL_BEHAVIOR.finalContextTopK),
    RETRIEVAL_BEHAVIOR.rerank.candidateLimit,
  );
