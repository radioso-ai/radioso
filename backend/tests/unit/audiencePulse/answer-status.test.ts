import { describe, expect, it } from "vitest";

import {
  answerStatus,
  isShortfallStatus,
  summarizeAnswerStatuses,
  type AudiencePulseAnswerStatusInput,
} from "../../../src/modules/audiencePulse/domain/answerStatus.js";

const assessed = (
  coverage: "answered" | "partial" | "unanswered" | "unclear",
  reason: "sufficient_evidence" | "insufficient_evidence" | "conflicting_evidence" | "ambiguous_request" | "intentional_scope_boundary",
): AudiencePulseAnswerStatusInput => ({
  grounding: "grounded",
  contentGapEligible: false,
  legacyCoverage: false,
  answerCoverage: { availability: "assessed", coverage, reason, schemaVersion: 1, producer: "answer_head" },
});

const legacy = (
  grounding: AudiencePulseAnswerStatusInput["grounding"],
  contentGapEligible: boolean,
): AudiencePulseAnswerStatusInput => ({ grounding, contentGapEligible, legacyCoverage: true });

describe("answerStatus", () => {
  it("reads an assessed verdict as its coverage", () => {
    expect(answerStatus(assessed("answered", "sufficient_evidence"))).toBe("answered");
    expect(answerStatus(assessed("partial", "insufficient_evidence"))).toBe("partial");
    expect(answerStatus(assessed("unanswered", "conflicting_evidence"))).toBe("unanswered");
    expect(answerStatus(assessed("unclear", "ambiguous_request"))).toBe("unclear");
  });

  it("reads a partial or unanswered scope-boundary verdict as out of scope", () => {
    expect(answerStatus(assessed("unanswered", "intentional_scope_boundary"))).toBe("out_of_scope");
    expect(answerStatus(assessed("partial", "intentional_scope_boundary"))).toBe("out_of_scope");
  });

  it("keeps an answered or unclear verdict as its coverage whatever its reason", () => {
    expect(answerStatus(assessed("answered", "intentional_scope_boundary"))).toBe("answered");
    expect(answerStatus(assessed("unclear", "intentional_scope_boundary"))).toBe("unclear");
  });

  it("reads a recorded assessment that did not complete as not assessed, whatever its grounding", () => {
    for (const availability of ["not_recorded", "failed", "invalid"] as const) {
      expect(answerStatus({
        grounding: "no_support",
        contentGapEligible: true,
        legacyCoverage: false,
        answerCoverage: { availability },
      })).toBe("not_assessed");
    }
  });

  it("reads a pending assessment as not assessed, never from grounding", () => {
    expect(answerStatus({ grounding: "no_support", contentGapEligible: false, legacyCoverage: false })).toBe("not_assessed");
    expect(answerStatus({ grounding: "grounded", contentGapEligible: false, legacyCoverage: false })).toBe("not_assessed");
  });

  it("reads a question with no assessment record from its retrieval content-gap grounding", () => {
    expect(answerStatus(legacy("degraded", true))).toBe("partial");
    expect(answerStatus(legacy("no_support", true))).toBe("unanswered");
    expect(answerStatus(legacy("grounded", true))).toBe("answered");
    expect(answerStatus(legacy("unknown", true))).toBe("not_assessed");
  });

  it("does not call a non-retrieval failure a shortfall when there is no assessment record", () => {
    expect(answerStatus(legacy("degraded", false))).toBe("not_assessed");
    expect(answerStatus(legacy("no_support", false))).toBe("not_assessed");
    expect(answerStatus(legacy("unknown", false))).toBe("not_assessed");
  });

  it("reads a grounded answer with no assessment record as answered", () => {
    expect(answerStatus(legacy("grounded", false))).toBe("answered");
    expect(answerStatus({ grounding: "grounded", contentGapEligible: false })).toBe("answered");
  });
});

describe("isShortfallStatus", () => {
  it("is true only for partly answered and unanswered", () => {
    expect(isShortfallStatus("partial")).toBe(true);
    expect(isShortfallStatus("unanswered")).toBe(true);
    for (const status of ["answered", "unclear", "out_of_scope", "not_assessed"] as const) {
      expect(isShortfallStatus(status)).toBe(false);
    }
  });
});

describe("summarizeAnswerStatuses", () => {
  it("counts every status into its own bucket", () => {
    expect(summarizeAnswerStatuses([
      "answered", "answered", "partial", "unanswered", "unclear", "out_of_scope", "out_of_scope", "not_assessed",
    ])).toEqual({ answered: 2, partial: 1, unanswered: 1, unclear: 1, outOfScope: 2, notAssessed: 1 });
  });
});
