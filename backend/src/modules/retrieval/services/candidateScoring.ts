import { RETRIEVAL_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import type { RetrievedCandidate } from "../domain/retrievalPipelineTypes.js";

export const clampNormalizedScore = (score: number): number => {
  if (!Number.isFinite(score)) {
    return 0;
  }
  return Math.max(0, Math.min(1, score));
};

export const reciprocalRankContribution = (rank: number | undefined): number => {
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
  const primary = Math.max(semantic, lexical);
  const secondary = Math.min(semantic, lexical);
  const secondaryWeight = RETRIEVAL_BEHAVIOR.candidateMergeSecondaryWeight;

  return clampNormalizedScore((primary + secondaryWeight * secondary) / (1 + secondaryWeight));
};

export const getCandidateFusedScore = (candidate: Pick<RetrievedCandidate, "fusedScore" | "similarity">): number =>
  clampNormalizedScore(candidate.fusedScore ?? candidate.similarity);

export const applyBoundedCandidateBoost = (score: number, boost: number): number => {
  const normalizedScore = clampNormalizedScore(score);
  const normalizedBoost = clampNormalizedScore(boost);
  return clampNormalizedScore(normalizedScore + normalizedBoost * (1 - normalizedScore));
};

export const hasUsefulCandidateEvidence = (
  candidate: Pick<RetrievedCandidate, "semanticScore" | "lexicalRankScore">,
): boolean =>
  candidate.semanticScore > 0 ||
  (candidate.lexicalRankScore ?? 0) >= RETRIEVAL_BEHAVIOR.hybrid.lexicalMinimumUsefulRankScore;

export const compareByFusedScore = (left: RetrievedCandidate, right: RetrievedCandidate): number =>
  getCandidateFusedScore(right) - getCandidateFusedScore(left) ||
  right.semanticScore - left.semanticScore ||
  (right.lexicalRankScore ?? 0) - (left.lexicalRankScore ?? 0) ||
  right.lexicalScore - left.lexicalScore;
