import type { RetrievedCandidate } from "../../domain/retrievalPipelineTypes.js";
import { positionInDateRange, type RequestedDateRange } from "../../domain/temporal/requestedDateRange.js";
import { applyBoundedCandidateBoost, getCandidateFusedScore } from "../candidateScoring.js";

const UPCOMING_EVENT_BOOST = 0.08;

/**
 * Boosts the dated candidates a temporal question is about: those overlapping the requested
 * range when the question names one, otherwise those still ongoing or upcoming today.
 */
export const applyUpcomingEventBoost = (input: {
  candidates: RetrievedCandidate[];
  enabled: boolean;
  today: string;
  dateRange?: RequestedDateRange;
}): RetrievedCandidate[] => {
  if (!input.enabled) {
    return input.candidates;
  }
  const dateRange = input.dateRange;
  const isInFocus = dateRange
    ? (metadata: Record<string, unknown> | undefined) => positionInDateRange(metadataDates(metadata), dateRange) === "within"
    : (metadata: Record<string, unknown> | undefined) => isOngoingOrUpcoming(metadata, input.today);

  return input.candidates.map((candidate) => {
    if (!isInFocus(candidate.metadata)) {
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

const metadataDates = (metadata: Record<string, unknown> | undefined): { dateFrom?: string; dateTo?: string } => ({
  ...(typeof metadata?.dateFrom === "string" ? { dateFrom: metadata.dateFrom.slice(0, 10) } : {}),
  ...(typeof metadata?.dateTo === "string" ? { dateTo: metadata.dateTo.slice(0, 10) } : {}),
});

const isOngoingOrUpcoming = (metadata: Record<string, unknown> | undefined, today: string): boolean => {
  const { dateFrom, dateTo } = metadataDates(metadata);
  return Boolean((dateFrom && dateFrom >= today) || (dateTo && dateTo >= today));
};
