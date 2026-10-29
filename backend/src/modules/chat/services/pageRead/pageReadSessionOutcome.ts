import type { AssistantPageContext } from "../../types/assistantApi.js";
import {
  evaluatePageReadGate,
  mergePageReadDecision,
  type MergedPageReadDecision,
  type PageReadCandidate,
  type PageReadCandidateSource,
  type PageReadCapability,
  type PageReadDecision,
  type PageReadGateOutcome,
  type PageReadOperation,
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

/**
 * The page fields this turn's read admits, or null when the gate captured nothing. A read
 * served as `metadata` admits the page's identity alone, whatever else the request carried,
 * so what is staged always matches the operation the trace reports.
 */
export const capturedPageContext = (
  outcome: PageReadOutcome | undefined,
  pageContext: AssistantPageContext | null | undefined,
): AssistantPageContext | null => {
  if (outcome?.gate.kind !== "capture" || !pageContext) {
    return null;
  }
  if (outcome.gate.operation !== "metadata") {
    return pageContext;
  }
  const { content: _content, ...identity } = pageContext;
  return identity;
};

/**
 * Whether the page this turn captured is evidence an answer may state facts from without
 * citing a retrieved excerpt. Its content is. Its identity alone is only when a contributor
 * asked for it by name: the URL and title answer "what page am I on?", while a request for
 * the page as context leaves them context for the routine step that references them.
 */
export const admitsPageEvidence = (outcome: PageReadOutcome | undefined): boolean =>
  outcome?.gate.kind === "capture"
  && (outcome.gate.operation !== "metadata"
    || outcome.merged.contributors.some((contributor) => contributor.operation === "metadata"));

/** What a turn's message metadata records of its page read: the request, its winner, and what the gate served. */
export interface PageReadRecord {
  decision: MergedPageReadDecision["decision"];
  winnerSource: PageReadCandidateSource | null;
  gateOutcome: PageReadGateOutcome["kind"];
  servedOperation: PageReadOperation | null;
}

export const pageReadRecordOf = (outcome: PageReadOutcome): PageReadRecord => ({
  decision: outcome.merged.decision,
  winnerSource: outcome.merged.contributors[0]?.source ?? null,
  gateOutcome: outcome.gate.kind,
  servedOperation: outcome.gate.kind === "capture" ? outcome.gate.operation : null,
});
