import {
  evaluatePageReadGate,
  mergePageReadDecision,
  type MergedPageReadDecision,
  type PageReadCandidate,
  type PageReadCapability,
  type PageReadDecision,
  type PageReadGateOutcome,
  type PageReadRequest,
} from "./pageReadDecision.js";

export interface PageReadOutcome {
  merged: MergedPageReadDecision;
  gate: PageReadGateOutcome;
}

interface PageReadOutcomeCarrier {
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

/**
 * The operation an outcome reports: the one the gate served when it captured the page, so a
 * trace tells the page's identity (`metadata`) from its content; otherwise the one requested,
 * null when nothing asked to read the page.
 */
export const pageReadOperationOf = (outcome: PageReadOutcome): PageReadRequest | null =>
  outcome.gate.kind === "capture" ? outcome.gate.operation : outcome.merged.decision.operation;
