import { describe, expect, it } from "vitest";

import { audiencePulseCoverageGapEligible } from "../../../src/shared/domain/audiencePulseContentGap.js";
import { buildAudiencePulseReport } from "../../../src/modules/audiencePulse/domain/report.js";

describe("Audience Pulse semantic coverage eligibility", () => {
  it("includes only assessed partial or unanswered evidence gaps", () => {
    expect(audiencePulseCoverageGapEligible({ availability: "assessed", coverage: "unanswered", reason: "insufficient_evidence", schemaVersion: 1 })).toBe(true);
    expect(audiencePulseCoverageGapEligible({ availability: "assessed", coverage: "partial", reason: "conflicting_evidence", schemaVersion: 1 })).toBe(true);
    expect(audiencePulseCoverageGapEligible({ availability: "assessed", coverage: "unclear", reason: "ambiguous_request", schemaVersion: 1 })).toBe(false);
    expect(audiencePulseCoverageGapEligible({ availability: "assessed", coverage: "unanswered", reason: "intentional_scope_boundary", schemaVersion: 1 })).toBe(false);
    expect(audiencePulseCoverageGapEligible({ availability: "failed" })).toBe(false);
    expect(audiencePulseCoverageGapEligible(undefined)).toBe(false);
  });
});

it("keeps provisional coverage unassessed and reserves legacy for absent assessments", () => {
  const report = buildAudiencePulseReport({
    period: { start: new Date("2026-01-01T00:00:00.000Z"), end: new Date("2026-02-01T00:00:00.000Z") },
    generatedAt: new Date("2026-02-01T00:00:00.000Z"), isFirstCensus: false,
    coverage: { populationSize: 3, sampleSize: 3, sampled: false, facetReadyQuestionCount: 3 },
    weeklyVolume: [],
    population: [
      { id: "a", reference: { messageId: "a", conversationId: "c1" }, question: "A", weekStart: "2026-01-01T00:00:00.000Z", channel: null, grounding: "grounded", contentGapEligible: false, answerCoverage: { availability: "assessed", coverage: "answered", reason: "sufficient_evidence", schemaVersion: 1 } },
      { id: "b", reference: { messageId: "b", conversationId: "c2" }, question: "B", weekStart: "2026-01-01T00:00:00.000Z", channel: null, grounding: "no_support", contentGapEligible: true, legacyCoverage: true },
      { id: "c", reference: { messageId: "c", conversationId: "c3" }, question: "C", weekStart: "2026-01-01T00:00:00.000Z", channel: null, grounding: "grounded", contentGapEligible: false, legacyCoverage: false },
    ],
    topics: [{ id: "topic", title: "Topic", description: "Topic", evidenceIds: ["a", "b", "c"] }],
    model: { summary: "Summary", themes: [], recommendations: [], caveats: [] },
  });
  expect(report.themes[0]?.coverage).toEqual({ answered: 1, partial: 0, unanswered: 0, unclear: 0, unassessed: 1, legacy: 1, reasons: { sufficient_evidence: 1 } });
});

it("never persists unresolved visitor text in a Pulse report", () => {
  const report = buildAudiencePulseReport({
    period: { start: new Date("2026-01-01T00:00:00.000Z"), end: new Date("2026-02-01T00:00:00.000Z") }, generatedAt: new Date(), isFirstCensus: false,
    coverage: { populationSize: 2, sampleSize: 2, sampled: false, facetReadyQuestionCount: 2 }, weeklyVolume: [],
    population: ["a", "b"].map((id) => ({ id, reference: { messageId: id, conversationId: id }, question: id, weekStart: "2026-01-01T00:00:00.000Z", channel: null, grounding: "no_support" as const, contentGapEligible: true, answerCoverage: { availability: "assessed" as const, coverage: "unanswered" as const, reason: "insufficient_evidence" as const, unresolvedRequest: "email me at visitor@example.test", schemaVersion: 1 } })),
    topics: [{ id: "topic", title: "Topic", description: "Topic", evidenceIds: ["a", "b"] }], model: { summary: "Summary", themes: [], recommendations: [], caveats: [] },
  });
  expect(JSON.stringify(report)).not.toContain("visitor@example.test");
});
