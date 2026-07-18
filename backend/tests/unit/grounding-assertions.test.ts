import { describe, expect, it } from "vitest";

import { parseGroundedAnswerEnvelope } from "../../src/modules/chat/services/groundedAnswerEnvelope.js";
import {
  computeGroundingSummary,
  hasValidSourcedAssertion,
  parseInlineAssertionGroups,
} from "../../src/modules/chat/services/groundingAssertions.js";
import {
  DEGRADED_V2_BODY,
  GROUNDED_V2_BODY,
  NO_SUPPORT_V2_BODY,
  degradedV2Envelope,
  formatV2Envelope,
  groundedV2Envelope,
  noSupportV2Envelope,
} from "../support/answerEnvelopeV2Fixtures.js";

const summarize = (raw: string, contextCount = 3) => {
  const envelope = parseGroundedAnswerEnvelope(raw);
  return computeGroundingSummary({
    body: envelope.answer,
    envelope,
    contextCount,
  });
};

describe("grounding assertions", () => {
  it("computes grounded for exact, fully sourced v2 assertions", () => {
    expect(summarize(groundedV2Envelope())).toEqual({
      protocolVersion: 2,
      parseStatus: "valid_v2",
      verdict: "grounded",
      claimCount: 2,
      sourcedClaimCount: 2,
      unsourcedClaimCount: 0,
      invalidSourceCount: 0,
      assertionMismatch: false,
    });
  });

  it("keeps an explicitly unsourced limitation visible and degraded", () => {
    expect(summarize(degradedV2Envelope())).toMatchObject({
      verdict: "degraded",
      claimCount: 2,
      sourcedClaimCount: 1,
      unsourcedClaimCount: 1,
      invalidSourceCount: 0,
      assertionMismatch: false,
    });
  });

  it("computes no_support for the canonical same-call decline", () => {
    expect(summarize(noSupportV2Envelope())).toMatchObject({
      verdict: "no_support",
      claimCount: 0,
      sourcedClaimCount: 0,
      unsourcedClaimCount: 0,
      assertionMismatch: false,
    });
  });

  it("allows matching unsourced assertions on no-support copy", () => {
    const raw = formatV2Envelope("Contact our team[[?]].", {
      v: 2,
      outcome: "no_support",
      claims: [[]],
      suggestions: [],
      grounding: "degraded",
    });
    expect(summarize(raw, 0)).toMatchObject({ verdict: "no_support", unsourcedClaimCount: 1 });
  });

  it.each([
    ["missing", "Visible answer without a tail.", "missing"],
    ["malformed", formatV2Envelope("Visible answer.", { v: 2 }).replace(/\{.*$/, "{bad"), "malformed"],
    ["legacy array", formatV2Envelope("Visible answer.", []), "legacy_v1"],
    ["legacy object", formatV2Envelope("Visible answer.", { grounding: "grounded", suggestions: [] }), "legacy_v1"],
    ["unknown version", formatV2Envelope("Visible answer.", { v: 3, outcome: "answer", claims: [], suggestions: [] }), "invalid_v2"],
    ["unknown outcome", formatV2Envelope("Visible answer.", { v: 2, outcome: "maybe", claims: [], suggestions: [] }), "invalid_v2"],
  ])("fails %s output degraded", (_name, raw, parseStatus) => {
    expect(summarize(raw)).toMatchObject({ verdict: "degraded", parseStatus });
  });

  it.each([
    ["anchor-free body", "An answer.", [[1]], true],
    ["marker count", "One[[1]].", [[1], [2]], true],
    ["marker order", "One[[1]]. Two[[2]].", [[2], [1]], true],
    ["source membership", "One[[1]][[2]].", [[1, 3]], true],
    ["unsourced position", "One[[?]]. Two[[1]].", [[1], []], true],
  ])("degrades on %s mismatch", (_name, body, claims, expectedMismatch) => {
    const raw = formatV2Envelope(body, {
      v: 2,
      outcome: "answer",
      claims,
      suggestions: [],
      grounding: "degraded",
    });
    expect(summarize(raw)).toMatchObject({ verdict: "degraded", assertionMismatch: expectedMismatch });
  });

  it("accepts numeric strings, duplicate indices, extra keys, and v as a string", () => {
    const raw = formatV2Envelope("One[[1]][[1]][[2]].", {
      v: "2",
      outcome: "answer",
      claims: [["1", 1, "2"]],
      suggestions: [],
      grounding: "grounded",
      ignored: true,
    });
    expect(summarize(raw, 2)).toMatchObject({ verdict: "grounded", assertionMismatch: false });
  });

  it.each(["[[0]]", "[[-1]]", "[[999]]", "[[nope]]", "[[1e0]]", "[[1.0]]", "[[+1]]", "[[ 1 ]]", "[[\t1]]", "[[1"])(
    "treats %s as invalid and never sourced",
    (marker) => {
      const raw = formatV2Envelope(`Claim${marker}.`, {
        v: 2,
        outcome: "answer",
        claims: [[marker === "[[999]]" ? 999 : 1]],
        suggestions: [],
        grounding: "degraded",
      });
      const summary = summarize(raw, 2);
      expect(summary.verdict).toBe("degraded");
      expect(summary.invalidSourceCount).toBeGreaterThan(0);
      expect(hasValidSourcedAssertion(`Claim${marker}.`, 2)).toBe(false);
    },
  );

  it("invalidates no_support when it has sources, suggestions, invalid indices, or mismatches", () => {
    const cases = [
      formatV2Envelope("Fact[[1]].", { v: 2, outcome: "no_support", claims: [[1]], suggestions: [] }),
      formatV2Envelope(NO_SUPPORT_V2_BODY, { v: 2, outcome: "no_support", claims: [], suggestions: [{ text: "Why?", contextIndex: 1 }] }),
      formatV2Envelope("Limit[[999]].", { v: 2, outcome: "no_support", claims: [[999]], suggestions: [] }),
      formatV2Envelope("Limit[[?]].", { v: 2, outcome: "no_support", claims: [], suggestions: [] }),
      formatV2Envelope(NO_SUPPORT_V2_BODY, { v: 2, outcome: "no_support", claims: [], suggestions: ["invalid"] }),
    ];
    for (const raw of cases) {
      expect(summarize(raw)).toMatchObject({ verdict: "degraded" });
    }
  });

  it("parses ordered adjacent source groups and explicit unsourced groups", () => {
    expect(parseInlineAssertionGroups(`${GROUNDED_V2_BODY} ${DEGRADED_V2_BODY}`, 3).groups).toEqual([
      [1],
      [2, 3],
      [1],
      [],
    ]);
  });
});
