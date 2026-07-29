import { describe, expect, it } from "vitest";

import {
  buildGroundingCountPresencePredicate,
  buildGroundingVerdictPredicate,
  mapGroundingDiagnostic,
} from "../../src/modules/quality/groundingDiagnostic.js";

describe("quality grounding diagnostic mapping", () => {
  it("returns a complete diagnostic", () => {
    expect(mapGroundingDiagnostic({
      grounding_verdict: "degraded",
      grounding_claim_count: 3,
      grounding_sourced_claim_count: 2,
      grounding_unsourced_claim_count: 1,
      grounding_invalid_source_count: 0,
    })).toEqual({
      verdict: "degraded",
      claimCount: 3,
      sourcedClaimCount: 2,
      unsourcedClaimCount: 1,
      invalidSourceCount: 0,
    });
  });

  it("builds deduplicated verdict and complete-diagnostic count predicates", () => {
    const params: unknown[] = [];
    expect(buildGroundingVerdictPredicate(["degraded", "degraded", "no_support"], params))
      .toBe("m.grounding_verdict = ANY($1::text[])");
    expect(params).toEqual([["degraded", "no_support"]]);
    expect(buildGroundingCountPresencePredicate("grounding_unsourced_claim_count", true))
      .toBe("m.grounding_verdict IS NOT NULL AND m.grounding_unsourced_claim_count > 0");
    expect(buildGroundingCountPresencePredicate("grounding_invalid_source_count", false))
      .toBe("m.grounding_verdict IS NOT NULL AND m.grounding_invalid_source_count = 0");
  });

  it("returns null instead of fabricating zeroes for partial or inconsistent rows", () => {
    expect(mapGroundingDiagnostic({
      grounding_verdict: "degraded",
      grounding_claim_count: 1,
      grounding_sourced_claim_count: null,
      grounding_unsourced_claim_count: null,
      grounding_invalid_source_count: 0,
    })).toBeNull();
    expect(mapGroundingDiagnostic({
      grounding_verdict: "grounded",
      grounding_claim_count: 2,
      grounding_sourced_claim_count: 1,
      grounding_unsourced_claim_count: 0,
      grounding_invalid_source_count: 0,
    })).toBeNull();
  });
});
