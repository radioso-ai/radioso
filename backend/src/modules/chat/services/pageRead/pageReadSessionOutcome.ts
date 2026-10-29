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
 * A read whose only `metadata` serve came from downgrading a request for the page as context
 * (a routine step that reads it, on a channel that sends no content): nobody named `metadata`,
 * so the page's URL and title are context for that step, never the whole page or evidence.
 */
const isIdentityOnlyContextRead = (outcome: PageReadOutcome): boolean =>
  outcome.gate.kind === "capture"
  && outcome.gate.operation === "metadata"
  && !outcome.merged.contributors.some((contributor) => contributor.operation === "metadata");

/**
 * The page fields this turn's read admits, or null when the gate captured nothing. A read that
 * names its operation stages what the request carried. A request for the page as context
 * downgraded to `metadata` stages the page's identity alone, so a routine step never sees an
 * excerpt the trace reports it did not get.
 */
export const capturedPageContext = (
  outcome: PageReadOutcome | undefined,
  pageContext: AssistantPageContext | null | undefined,
): AssistantPageContext | null => {
  if (outcome?.gate.kind !== "capture" || !pageContext) {
    return null;
  }
  if (!isIdentityOnlyContextRead(outcome)) {
    return pageContext;
  }
  const { content: _content, ...identity } = pageContext;
  return identity;
};

/**
 * Whether the page this turn captured is evidence an answer may state facts from without
 * citing a retrieved excerpt: any captured read but a request for the page as context
 * downgraded to `metadata`. A named `metadata` read admits the URL and title, which answer
 * "what page am I on?".
 */
export const admitsPageEvidence = (outcome: PageReadOutcome | undefined): boolean =>
  outcome?.gate.kind === "capture" && !isIdentityOnlyContextRead(outcome);

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
