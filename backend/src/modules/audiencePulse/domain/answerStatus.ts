import type { AnswerCoverageAssessment } from "@radioso/conversation-contract";

import type { AudiencePulseGroundingSignal } from "../../../shared/domain/audiencePulseContentGap.js";

/**
 * What happened to one visitor question, as Audience Pulse reports it. This is the
 * single rule behind a topic's answer counts, its sampled examples, and each
 * example's label; the dashboard renders these values and never re-derives them.
 */
export type AudiencePulseAnswerStatus =
  | "answered"
  | "partial"
  | "unanswered"
  | "unclear"
  | "out_of_scope"
  | "not_assessed";

export const AUDIENCE_PULSE_ANSWER_STATUSES = [
  "answered",
  "partial",
  "unanswered",
  "unclear",
  "out_of_scope",
  "not_assessed",
] as const satisfies readonly AudiencePulseAnswerStatus[];

/** The evidence fields the rule reads. */
export interface AudiencePulseAnswerStatusInput {
  answerCoverage?: AnswerCoverageAssessment;
  /** False when an assessment exists but is not yet confirmed; absent or true when no record exists. */
  legacyCoverage?: boolean;
  grounding: AudiencePulseGroundingSignal;
  contentGapEligible: boolean;
}

export const answerStatus = (item: AudiencePulseAnswerStatusInput): AudiencePulseAnswerStatus => {
  const assessment = item.answerCoverage;
  if (assessment) {
    if (assessment.availability !== "assessed") return "not_assessed";
    // Declining a request outside the agent's intended scope is authored behavior, not a shortfall.
    if ((assessment.coverage === "partial" || assessment.coverage === "unanswered")
      && assessment.reason === "intentional_scope_boundary") {
      return "out_of_scope";
    }
    return assessment.coverage;
  }
  // A pending assessment stays unassessed: reading its grounding would invent a verdict.
  if (item.legacyCoverage === false) return "not_assessed";
  // With no assessment record, only a retrieval answer the content-gap rule already
  // trusts counts as a shortfall.
  if (item.contentGapEligible) {
    if (item.grounding === "degraded") return "partial";
    if (item.grounding === "no_support") return "unanswered";
  }
  return item.grounding === "grounded" ? "answered" : "not_assessed";
};

/** A question the agent fell short on: partly answered or unanswered. */
export const isShortfallStatus = (status: AudiencePulseAnswerStatus): boolean =>
  status === "partial" || status === "unanswered";

export interface AudiencePulseAnswerSummary {
  answered: number;
  partial: number;
  unanswered: number;
  unclear: number;
  outOfScope: number;
  notAssessed: number;
}

const SUMMARY_KEY: Record<AudiencePulseAnswerStatus, keyof AudiencePulseAnswerSummary> = {
  answered: "answered",
  partial: "partial",
  unanswered: "unanswered",
  unclear: "unclear",
  out_of_scope: "outOfScope",
  not_assessed: "notAssessed",
};

export const summarizeAnswerStatuses = (statuses: Iterable<AudiencePulseAnswerStatus>): AudiencePulseAnswerSummary => {
  const summary: AudiencePulseAnswerSummary = {
    answered: 0, partial: 0, unanswered: 0, unclear: 0, outOfScope: 0, notAssessed: 0,
  };
  for (const status of statuses) summary[SUMMARY_KEY[status]] += 1;
  return summary;
};
