import { describe, expect, it } from "vitest";

import {
  buildAudiencePulseReport,
  contentGapEligible,
  type AudiencePulseEvidence,
} from "../../../src/modules/audiencePulse/domain/report.js";

const period = {
  start: new Date("2026-07-01T00:00:00.000Z"),
  end: new Date("2026-07-31T00:00:00.000Z"),
};

const evidence = (overrides: Partial<AudiencePulseEvidence> = {}): AudiencePulseEvidence => ({
  id: "evidence-1",
  reference: {
    messageId: "11111111-1111-1111-1111-111111111111",
    conversationId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  },
  question: "How do I change my plan?",
  weekStart: "2026-06-29T00:00:00.000Z",
  channel: null,
  grounding: "no_support",
  contentGapEligible: true,
  ...overrides,
});

const baseInput = {
  period,
  generatedAt: new Date("2026-08-01T00:00:00.000Z"),
  coverage: { populationSize: 3, sampleSize: 3, sampled: false },
  weeklyVolume: [{
    weekStart: "2026-06-29T00:00:00.000Z",
    visitorQuestionCount: 3,
    conversationCount: 2,
  }],
};

describe("Audience Pulse report domain", () => {
  it("qualifies only the two typed retrieval outcomes with matching diagnostics", () => {
    expect(contentGapEligible({
      assistantAuthorship: "ai",
      skillName: "retrieval.answer",
      skillOutcome: "no_context",
      grounding: "no_support",
    })).toBe(true);
    expect(contentGapEligible({
      assistantAuthorship: "ai",
      skillName: "retrieval.answer",
      skillOutcome: "grounded_degraded",
      grounding: "degraded",
    })).toBe(true);
    expect(contentGapEligible({
      assistantAuthorship: "ai",
      skillName: "retrieval.answer",
      skillOutcome: "out_of_scope",
      grounding: "no_support",
    })).toBe(false);
    expect(contentGapEligible({
      assistantAuthorship: "human",
      skillName: "retrieval.answer",
      skillOutcome: "no_context",
      grounding: "no_support",
    })).toBe(false);
  });

  it("derives theme counts and recurring content gaps from verified evidence", () => {
    const report = buildAudiencePulseReport({
      ...baseInput,
      evidence: [
        evidence(),
        evidence({
          id: "evidence-2",
          reference: {
            messageId: "22222222-2222-2222-2222-222222222222",
            conversationId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
          },
          question: "Can I update my subscription?",
        }),
        evidence({
          id: "evidence-3",
          reference: {
            messageId: "33333333-3333-3333-3333-333333333333",
            conversationId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
          },
          grounding: "grounded",
          contentGapEligible: false,
        }),
      ],
      model: {
        summary: "Visitors ask about subscription changes.",
        themes: [{
          title: "Subscription changes",
          description: "Questions about changing a plan.",
          evidenceIds: ["evidence-1", "evidence-2", "evidence-3"],
        }],
        recommendations: [{
          themeIndex: 0,
          title: "Explain subscription changes",
          rationale: "Repeated unsupported questions.",
          questions: ["How can I change my plan?"],
          evidenceIds: ["evidence-1", "evidence-2"],
        }],
        caveats: [],
      },
    });

    expect(report.themes[0]?.grounding).toEqual({
      grounded: 1,
      degraded: 0,
      noSupport: 2,
      unknown: 0,
      contentGapEligible: 2,
    });
    expect(report.contentGaps).toEqual([{
      themeId: report.themes[0]?.id,
      eligibleEvidenceCount: 2,
      distinctConversationCount: 2,
    }]);
    expect(report.recommendations).toHaveLength(1);
  });

  it("rejects evidence reused across two primary themes", () => {
    expect(() => buildAudiencePulseReport({
      ...baseInput,
      evidence: [evidence(), evidence({ id: "evidence-2" }), evidence({ id: "evidence-3" })],
      model: {
        summary: "Summary",
        themes: [
          { title: "First", description: "First theme", evidenceIds: ["evidence-1", "evidence-2"] },
          { title: "Second", description: "Second theme", evidenceIds: ["evidence-1", "evidence-3"] },
        ],
        recommendations: [],
        caveats: [],
      },
    })).toThrow(/more than one theme/i);
  });

  it("rejects recommendations without two eligible conversations in the parent theme", () => {
    expect(() => buildAudiencePulseReport({
      ...baseInput,
      evidence: [
        evidence(),
        evidence({
          id: "evidence-2",
          reference: {
            messageId: "22222222-2222-2222-2222-222222222222",
            conversationId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
          },
        }),
      ],
      model: {
        summary: "Summary",
        themes: [{ title: "Theme", description: "Description", evidenceIds: ["evidence-1", "evidence-2"] }],
        recommendations: [{
          themeIndex: 0,
          title: "Recommendation",
          rationale: "Rationale",
          questions: ["Question"],
          evidenceIds: ["evidence-1", "evidence-2"],
        }],
        caveats: [],
      },
    })).toThrow(/distinct conversations/i);
  });
});
