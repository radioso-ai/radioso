import {
  evaluatePageReadGate,
  mergePageReadDecision,
  type MergedPageReadDecision,
  type PageReadCandidate,
  type PageReadCapability,
  type PageReadDecision,
  type PageReadGateOutcome,
} from "./pageReadDecision.js";

export interface PageReadOutcome {
  merged: MergedPageReadDecision;
  gate: PageReadGateOutcome;
}

export interface PageReadOutcomeCarrier {
  pageReadCapability?: PageReadCapability | null;
  pageReadOutcome?: PageReadOutcome;
}

export const freezePageReadOutcome = (
  carrier: PageReadOutcomeCarrier,
  input: {
    planner: PageReadDecision | null;
    routineCandidates: readonly PageReadCandidate[];
    directiveCandidates: readonly PageReadCandidate[];
    fallbackRequest: string;
  },
): PageReadOutcome => {
  if (carrier.pageReadOutcome) {
    return carrier.pageReadOutcome;
  }
  const merged = mergePageReadDecision(input);
  const outcome = {
    merged,
    gate: evaluatePageReadGate(merged, carrier.pageReadCapability ?? null),
  };
  carrier.pageReadOutcome = outcome;
  return outcome;
};
