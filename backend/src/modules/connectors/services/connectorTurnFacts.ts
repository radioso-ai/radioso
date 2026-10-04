import type { ConnectorChatOutcome, ConnectorTurnFacts, ConnectorTurnResult } from "@radioso/connector-api";

import {
  SKILL_TURN_OUTCOME,
  type ChatReviewResult,
  type ReviewTurnFactsSource,
} from "../../chat/contracts/index.js";

/** The ownership reason for a review turn that produced nothing a person could review. */
const REVIEW_UNAVAILABLE_REASON = "review_unavailable";

/**
 * Maps the turn's skill outcome onto the connector-facing result. Declines and
 * generation failure stay distinct so connectors can escalate only real content gaps
 * without presenting provider/configuration failures as successful answers.
 */
export const connectorChatOutcome = (skillOutcome: string | null | undefined): ConnectorChatOutcome => {
  if (skillOutcome === SKILL_TURN_OUTCOME.RETRIEVAL_NO_CONTEXT.outcome) {
    return "no_context";
  }
  if (skillOutcome === SKILL_TURN_OUTCOME.RETRIEVAL_OUT_OF_SCOPE.outcome) {
    return "out_of_scope";
  }
  if (skillOutcome === SKILL_TURN_OUTCOME.RETRIEVAL_UNAVAILABLE.outcome) {
    return "unavailable";
  }
  return "answered";
};

const grounding = (answerOutcome: ReviewTurnFactsSource["answerOutcome"]): ConnectorTurnFacts["grounding"] => {
  switch (answerOutcome) {
    // A partial answer is grounded as far as it goes; the coverage fact carries `partial`.
    case "grounded_success":
    case "coverage_partial":
      return "grounded";
    case "no_context_refusal":
    case "coverage_unanswered":
      return "ungrounded";
    case "non_retrieval_response":
      return "not_applicable";
    case "coverage_unclear":
    case "coverage_unavailable":
    case null:
      return "unknown";
    default:
      // An outcome this mapper does not know yet is not evidence of grounding.
      return "unknown";
  }
};

const coverage = (record: ReviewTurnFactsSource["answerCoverage"]): ConnectorTurnFacts["coverage"] => {
  if (!record) {
    return "not_assessed";
  }
  switch (record.availability) {
    case "assessed":
      // An assessed record without a verdict is malformed; it fails closed like a failed assessment.
      return record.coverage ?? "unavailable";
    case "not_recorded":
      return "not_assessed";
    case "failed":
    case "invalid":
      return "unavailable";
    default:
      return "unavailable";
  }
};

const handoff = (
  signal: ReviewTurnFactsSource["ownershipHandoffSignal"],
  kind: "draft" | "no_draft",
): ConnectorTurnFacts["handoff"] => {
  if (signal) {
    return { requested: true, reason: signal.reason };
  }
  // With nothing to review, the conversation needs a person even though the turn asked for none.
  return kind === "no_draft" ? { requested: true, reason: REVIEW_UNAVAILABLE_REASON } : { requested: false };
};

/** The facts a connector's publication decision reads, mapped from what the review turn recorded. */
export const connectorTurnFacts = (
  facts: ReviewTurnFactsSource,
  kind: "draft" | "no_draft",
): ConnectorTurnFacts => ({
  outcome: connectorChatOutcome(facts.skillOutcome),
  grounding: grounding(facts.answerOutcome),
  coverage: coverage(facts.answerCoverage),
  handoff: handoff(facts.ownershipHandoffSignal, kind),
  suppressedEffects: facts.suppressedEffects.map((effect) => ({ skillName: effect.skillName })),
  citationCount: facts.citationCount,
});

export const connectorTurnResult = (result: ChatReviewResult): ConnectorTurnResult => {
  switch (result.kind) {
    case "draft":
      return {
        kind: "draft",
        conversationId: result.conversationId,
        ownershipVersion: result.ownershipVersion,
        facts: connectorTurnFacts(result.facts, "draft"),
        draft: { text: result.draft.text, presentation: result.draft.presentation },
      };
    case "no_draft":
      return {
        kind: "no_draft",
        conversationId: result.conversationId,
        ownershipVersion: result.ownershipVersion,
        facts: connectorTurnFacts(result.facts, "no_draft"),
      };
    case "human_owned":
      return { kind: "human_owned", conversationId: result.conversationId, ownershipVersion: result.ownershipVersion };
  }
};
