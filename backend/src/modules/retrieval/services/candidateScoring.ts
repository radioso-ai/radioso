import { RETRIEVAL_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import type { RetrievedCandidate } from "../domain/retrievalPipelineTypes.js";
import { isSomeTermsLexicalMatch, type LexicalTermCoverage, type RetrievedChunk } from "../domain/vectorSearch.js";

export const clampNormalizedScore = (score: number): number => {
  if (!Number.isFinite(score)) {
    return 0;
  }
  return Math.max(0, Math.min(1, score));
};

const reciprocalRankContribution = (rank: number | undefined): number => {
  if (!rank || !Number.isInteger(rank) || rank < 1) {
    return 0;
  }
  const k = RETRIEVAL_BEHAVIOR.candidateFusionRrfK;
  return clampNormalizedScore((k + 1) / (k + rank));
};

export const fuseCandidateRanks = (input: {
  semanticRank?: number;
  lexicalRank?: number;
  lexicalScore: number;
  lexicalTermCoverage?: LexicalTermCoverage;
}): number => {
  const semantic = reciprocalRankContribution(input.semanticRank);
  // Fusion is comparative, so the lexical gate reads the query-relative lexicalScore
  // rather than the absolute ts_rank_cd floor used by hasUsefulCandidateEvidence.
  // lexicalScore is normalized per lexical query call (rank / maxRank in
  // infra/lexicalSearch.ts), and candidatePreparationService.addSource takes the max
  // across branches, so in a multi-subquery turn each branch's best hit reaches 1.0.
  // That is intended: every branch contributes its own best candidate to the pool.
  const lexical = input.lexicalScore >= RETRIEVAL_BEHAVIOR.hybrid.lexicalFusionMinimumRelativeScore
    ? reciprocalRankContribution(input.lexicalRank)
    : 0;
  const secondaryWeight = RETRIEVAL_BEHAVIOR.candidateMergeSecondaryWeight;
  // A chunk holding only part of the query corroborates; it never leads. Its lexical
  // rank always enters as the secondary source: next to a semantic hit it lifts that
  // hit, and on its own it scores below semantic hits.
  if (isSomeTermsLexicalMatch(input)) {
    return clampNormalizedScore((semantic + secondaryWeight * lexical) / (1 + secondaryWeight));
  }
  const primary = Math.max(semantic, lexical);
  const secondary = Math.min(semantic, lexical);

  return clampNormalizedScore((primary + secondaryWeight * secondary) / (1 + secondaryWeight));
};

export const getCandidateFusedScore = (candidate: Pick<RetrievedCandidate, "fusedScore" | "similarity">): number =>
  clampNormalizedScore(candidate.fusedScore ?? candidate.similarity);

export const applyBoundedCandidateBoost = (score: number, boost: number): number => {
  const normalizedScore = clampNormalizedScore(score);
  const normalizedBoost = clampNormalizedScore(boost);
  return clampNormalizedScore(normalizedScore + normalizedBoost * (1 - normalizedScore));
};

// Lexical evidence means the chunk holds what was asked for, so a some-terms hit never
// counts, whatever its rank.
export const hasUsefulCandidateEvidence = (
  candidate: Pick<RetrievedCandidate, "semanticScore" | "lexicalRankScore" | "lexicalTermCoverage">,
): boolean =>
  candidate.semanticScore > 0 ||
  (!isSomeTermsLexicalMatch(candidate)
    && (candidate.lexicalRankScore ?? 0) >= RETRIEVAL_BEHAVIOR.hybrid.lexicalMinimumUsefulRankScore);

/**
 * Whether a candidate rests on more than a some-terms lexical match: another source found
 * it, or a lexical branch found every term. A turn whose candidates all fail this has
 * found nothing that answers it, however many partial keyword overlaps it holds.
 */
export const holdsPrimaryEvidence = (
  candidate: Pick<RetrievedCandidate, "retrievalSources" | "lexicalTermCoverage">,
): boolean =>
  candidate.retrievalSources.some((source) => source !== "lexical") || !isSomeTermsLexicalMatch(candidate);

/**
 * Orders lexical rows for their source rank: every all-terms hit first, by absolute
 * ts_rank_cd; some-terms hits after, by the share of the query's term weight they hold.
 */
export const compareLexicalEvidence = (left: RetrievedChunk, right: RetrievedChunk): number =>
  Number(isSomeTermsLexicalMatch(left)) - Number(isSomeTermsLexicalMatch(right))
  || (isSomeTermsLexicalMatch(left) ? right.similarity - left.similarity : 0)
  || (right.lexicalRankScore ?? 0) - (left.lexicalRankScore ?? 0);

export const compareByFusedScore = (left: RetrievedCandidate, right: RetrievedCandidate): number =>
  getCandidateFusedScore(right) - getCandidateFusedScore(left) ||
  right.semanticScore - left.semanticScore ||
  (right.lexicalRankScore ?? 0) - (left.lexicalRankScore ?? 0) ||
  right.lexicalScore - left.lexicalScore;
