import {
  ANSWER_COVERAGE_SCHEMA_VERSION,
  classifications,
} from "../../answerCoverage/public.js";
import type { AnswerCoverageAssessment } from "../contracts/answerCoverage.js";
import type { GroundedAnswerHead } from "./groundedAnswerHeadReader.js";

/**
 * Maps a parsed envelope head to the same assessment shape the pre-compose
 * assessor produces (mirrors `llmAnswerCoverageProducer.ts`): the classification
 * splits into `coverage`/`reason`, and `unresolvedRequest` carries the model's
 * `requestFocus` only when the request was not fully answered.
 */
export const buildAnswerCoverageAssessmentFromHead = (head: GroundedAnswerHead): AnswerCoverageAssessment => {
  const classification = classifications[head.coverage];
  return {
    availability: "assessed",
    coverage: classification.coverage,
    reason: classification.reason,
    ...(classification.coverage === "answered" ? {} : { unresolvedRequest: head.requestFocus }),
    schemaVersion: ANSWER_COVERAGE_SCHEMA_VERSION,
    producer: "answer_head",
  };
};

/** A head that failed to parse never fails the turn (FR-004); it simply carries no verdict. */
export const buildInvalidHeadAssessment = (): AnswerCoverageAssessment => ({
  availability: "invalid",
  producer: "answer_head",
});

/**
 * The zero-evidence branch never calls the model for a verdict at all — there is
 * nothing to compose from — so it reports a deterministic assessment instead
 * (FR-007), distinguishable from a model-produced head by `producer`.
 */
export const buildDeterministicZeroEvidenceAssessment = (unresolvedRequest: string): AnswerCoverageAssessment => ({
  availability: "assessed",
  coverage: "unanswered",
  reason: "insufficient_evidence",
  unresolvedRequest,
  schemaVersion: ANSWER_COVERAGE_SCHEMA_VERSION,
  producer: "deterministic",
});
