import { describe, expect, it } from "vitest";

import type { AnswerCoverageAssessment, SteeringRule } from "@radioso/conversation-contract";
import { steeringForKnownVerdict } from "../src/steering.js";

const rule = (overrides: Partial<SteeringRule> = {}): SteeringRule => ({
  action: "Be warm.",
  source: "directive",
  lifespan: "response",
  ...overrides,
});

const assessed = (
  overrides: Partial<Extract<AnswerCoverageAssessment, { availability: "assessed" }>> = {},
): AnswerCoverageAssessment => ({
  availability: "assessed",
  coverage: "unanswered",
  reason: "insufficient_evidence",
  schemaVersion: 1,
  producer: "deterministic",
  ...overrides,
});

describe("steeringForKnownVerdict (#1260 review round 3, Q3)", () => {
  it("passes an ordinary rule through unchanged", () => {
    const plain = rule();
    expect(steeringForKnownVerdict([plain], assessed())).toEqual([plain]);
  });

  it("renders a matching coverage-gated rule as a plain, unconditional instruction", () => {
    const gated = rule({
      action: "Offer the form.",
      coverageCriteria: { coverage: ["unanswered"] },
    });

    const result = steeringForKnownVerdict([gated], assessed());

    expect(result).toEqual([{ action: "Offer the form.", source: "directive", lifespan: "response" }]);
    expect(result[0]).not.toHaveProperty("coverageCriteria");
  });

  it("drops a coverage-gated rule whose criteria the known verdict does not satisfy", () => {
    const gated = rule({
      action: "Offer the form.",
      coverageCriteria: { coverage: ["answered"] },
    });

    expect(steeringForKnownVerdict([gated], assessed())).toEqual([]);
  });

  it("drops every coverage-gated rule when the assessment did not actually resolve to a verdict", () => {
    const gated = rule({
      action: "Offer the form.",
      coverageCriteria: { coverage: ["unanswered"] },
    });

    expect(steeringForKnownVerdict([gated], { availability: "invalid", producer: "answer_head" })).toEqual([]);
  });

  it("drops every coverage-gated rule when there is no verdict at all yet (pre-retrieval clarification)", () => {
    const gated = rule({
      action: "Offer the form.",
      coverageCriteria: { coverage: ["unanswered"] },
    });

    expect(steeringForKnownVerdict([gated], undefined)).toEqual([]);
  });

  it("keeps ordinary rules alongside a dropped coverage-gated rule", () => {
    const plain = rule({ action: "Be warm." });
    const gated = rule({ action: "Offer the form.", coverageCriteria: { coverage: ["answered"] } });

    expect(steeringForKnownVerdict([plain, gated], assessed())).toEqual([plain]);
  });
});
