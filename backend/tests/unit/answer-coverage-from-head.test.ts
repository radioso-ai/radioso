import { describe, expect, it } from "vitest";

import {
  buildAnswerCoverageAssessmentFromHead,
  buildDeterministicZeroEvidenceAssessment,
  buildInvalidHeadAssessment,
} from "../../src/modules/chat/services/answerCoverageFromHead.js";

describe("buildAnswerCoverageAssessmentFromHead", () => {
  it("splits an answered classification into coverage/reason without an unresolvedRequest", () => {
    expect(buildAnswerCoverageAssessmentFromHead({
      coverage: "answered_sufficient_evidence",
      requestFocus: "the workshop schedule",
      outcome: "answer",
    })).toEqual({
      availability: "assessed",
      coverage: "answered",
      reason: "sufficient_evidence",
      schemaVersion: 1,
      producer: "answer_head",
    });
  });

  it("carries requestFocus as unresolvedRequest for any non-answered classification", () => {
    expect(buildAnswerCoverageAssessmentFromHead({
      coverage: "partial_conflicting_evidence",
      requestFocus: "the accommodation fee",
      outcome: "answer",
    })).toEqual({
      availability: "assessed",
      coverage: "partial",
      reason: "conflicting_evidence",
      unresolvedRequest: "the accommodation fee",
      schemaVersion: 1,
      producer: "answer_head",
    });
  });

  it("tags the mapped assessment as answer_head, distinguishing it from the assessor", () => {
    const assessment = buildAnswerCoverageAssessmentFromHead({
      coverage: "unclear_ambiguous_request",
      requestFocus: "which session they mean",
      outcome: "answer",
    });
    expect(assessment.producer).toBe("answer_head");
  });
});

describe("buildInvalidHeadAssessment", () => {
  it("never fails the turn: it is just an unassessed, answer_head-produced marker", () => {
    expect(buildInvalidHeadAssessment()).toEqual({ availability: "invalid", producer: "answer_head" });
  });
});

describe("buildDeterministicZeroEvidenceAssessment", () => {
  it("reports unanswered/insufficient_evidence with the contextualized request, tagged deterministic", () => {
    expect(buildDeterministicZeroEvidenceAssessment("What is the capital of Mars?")).toEqual({
      availability: "assessed",
      coverage: "unanswered",
      reason: "insufficient_evidence",
      unresolvedRequest: "What is the capital of Mars?",
      schemaVersion: 1,
      producer: "deterministic",
    });
  });
});
