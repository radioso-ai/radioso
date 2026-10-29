import { RETRIEVAL_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";

/** The most passages any answer prompt holds. */
export const maxAnswerContextPassages = Math.max(
  RETRIEVAL_BEHAVIOR.finalContextTopK,
  RETRIEVAL_BEHAVIOR.temporal.dateRangeListingContextTopK,
);

/**
 * The document a passage counts against for the answer's `promptContextMaxPerDocument` limit:
 * passages under one title count together, and a passage with no title counts by its document.
 */
export const answerDocumentKey = (passage: { title: string; documentId: string }): string => {
  const titleKey = passage.title.replace(/\s+/g, " ").trim().toLowerCase();
  return titleKey ? `title:${titleKey}` : `document:${passage.documentId}`;
};

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
