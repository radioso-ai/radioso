import type { RetrievedCandidate } from "../../domain/retrievalPipelineTypes.js";
import { applyBoundedCandidateBoost, getCandidateFusedScore } from "../candidateScoring.js";

const UPCOMING_EVENT_BOOST = 0.08;

export const applyUpcomingEventBoost = (input: {
  candidates: RetrievedCandidate[];
  enabled: boolean;
  today: string;
}): RetrievedCandidate[] => {
  if (!input.enabled) {
    return input.candidates;
  }

  return input.candidates.map((candidate) => {
    if (!isOngoingOrUpcoming(candidate.metadata, input.today)) {
      return candidate;
    }

    const attributeMatchScore = Math.max(candidate.attributeMatchScore ?? 0, UPCOMING_EVENT_BOOST);
    const fusedScore = applyBoundedCandidateBoost(getCandidateFusedScore(candidate), UPCOMING_EVENT_BOOST);
    return {
      ...candidate,
      attributeMatchScore,
      fusedScore,
      similarity: fusedScore,
    };
  });
};

export const isOngoingOrUpcoming = (metadata: Record<string, unknown> | undefined, today: string): boolean => {
  const dateFrom = typeof metadata?.dateFrom === "string" ? metadata.dateFrom.slice(0, 10) : undefined;
  const dateTo = typeof metadata?.dateTo === "string" ? metadata.dateTo.slice(0, 10) : undefined;

  return Boolean((dateFrom && dateFrom >= today) || (dateTo && dateTo >= today));
};
