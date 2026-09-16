import { describe, expect, it } from "vitest";

import { steeringRulesForKnownVerdict } from "../../src/modules/chat/services/knownVerdictCoverageSteering.js";
import type { SteeringRule } from "../../src/shared/domain/steeringRule.js";
import type { AnswerCoverageAssessment } from "../../src/modules/chat/contracts/answerCoverage.js";

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

describe("steeringRulesForKnownVerdict", () => {
  it("passes an ordinary rule through unchanged", () => {
    const plain = rule();
    expect(steeringRulesForKnownVerdict([plain], assessed())).toEqual([plain]);
  });

  it("renders a matching coverage-gated rule as a plain, unconditional instruction", () => {
    const gated = rule({
      action: "Offer the form.",
      coverageCriteria: { coverage: ["unanswered"] },
    });

    const result = steeringRulesForKnownVerdict([gated], assessed());

    expect(result).toEqual([{ action: "Offer the form.", source: "directive", lifespan: "response" }]);
    expect(result[0]).not.toHaveProperty("coverageCriteria");
  });

  it("drops a coverage-gated rule whose criteria the known verdict does not satisfy", () => {
    const gated = rule({
      action: "Offer the form.",
      coverageCriteria: { coverage: ["answered"] },
    });

    expect(steeringRulesForKnownVerdict([gated], assessed())).toEqual([]);
  });

  it("drops every coverage-gated rule when no verdict was actually assessed", () => {
    const gated = rule({
      action: "Offer the form.",
      coverageCriteria: { coverage: ["unanswered"] },
    });

    expect(steeringRulesForKnownVerdict([gated], { availability: "invalid", producer: "answer_head" })).toEqual([]);
  });

  it("keeps ordinary rules alongside a dropped coverage-gated rule", () => {
    const plain = rule({ action: "Be warm." });
    const gated = rule({ action: "Offer the form.", coverageCriteria: { coverage: ["answered"] } });

    expect(steeringRulesForKnownVerdict([plain, gated], assessed())).toEqual([plain]);
  });
});
