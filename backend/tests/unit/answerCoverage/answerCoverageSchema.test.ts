import { describe, expect, it } from "vitest";

import {
  answerCoverageCriteriaSchema,
  LlmAnswerCoverageProducer,
} from "../../../src/modules/answerCoverage/public.js";

const assess = (value: unknown) => new LlmAnswerCoverageProducer({
  complete: async () => ({ text: typeof value === "string" ? value : JSON.stringify(value) }),
}).assess({
  contextualizedRequest: "Can I attend?",
  admissibleEvidence: [],
  usageContext: { workspaceId: "workspace-1", surface: "assistant", operation: "answer_coverage_assessment", attemptKey: "test" },
});

describe("answer coverage semantic output", () => {
  it("maps a strict resolved classification without persisting an unresolved request", async () => {
    await expect(assess({
      classification: "answered_sufficient_evidence",
      requestFocus: "One-day attendance",
    })).resolves.toMatchObject({
      availability: "assessed",
      coverage: "answered",
      reason: "sufficient_evidence",
    });
  });

  it("requires a non-empty focus string", async () => {
    await expect(assess({
      classification: "partial_insufficient_evidence",
      requestFocus: "",
    })).resolves.toEqual({ availability: "invalid" });
  });

  it("rejects extra properties and invalid typed values", async () => {
    await expect(assess({
      classification: "answered_sufficient_evidence",
      requestFocus: "One-day attendance",
      guess: true,
    })).resolves.toEqual({ availability: "invalid" });
  });

  it("rejects classification values outside the finite valid-pair mapping", async () => {
    for (const value of [
      { classification: "answered_insufficient_evidence", requestFocus: "One-day attendance" },
      { classification: "unclear_sufficient_evidence", requestFocus: "Which event" },
    ]) {
      await expect(assess(value)).resolves.toEqual({ availability: "invalid" });
    }
  });

  it("maps typed evidence-gap and ambiguity classifications", async () => {
    await expect(assess({
      classification: "partial_conflicting_evidence",
      requestFocus: "Which policy applies",
    })).resolves.toMatchObject({ availability: "assessed", coverage: "partial", reason: "conflicting_evidence" });
    await expect(assess({
      classification: "unclear_ambiguous_request",
      requestFocus: "Which event the visitor means",
    })).resolves.toMatchObject({ availability: "assessed", coverage: "unclear", reason: "ambiguous_request" });
  });

  it("validates authoring criteria without changing behavior when absent", () => {
    expect(answerCoverageCriteriaSchema.safeParse({
      coverage: ["partial", "unanswered"],
      reasons: ["insufficient_evidence"],
    }).success).toBe(true);
    expect(answerCoverageCriteriaSchema.safeParse({
      coverage: ["answered"],
      reasons: ["insufficient_evidence"],
    }).success).toBe(false);
  });

  it("keeps failed and invalid assessments non-triggering", async () => {
    await expect(assess("not json")).resolves.toEqual({ availability: "invalid" });
  });
});
