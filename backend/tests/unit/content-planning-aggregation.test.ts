import { describe, expect, it } from "vitest";

import {
  aggregateContentPlanTopic,
  countDistinctReportQuestions,
  resolveContentPlanWindows,
  resolveEvidenceStrength,
  resolveGroundingHeadlineState,
  resolveTopicTrend,
} from "../../src/modules/contentPlanning/domain/aggregationPolicy.js";

describe("content planning aggregation policy", () => {
  const asOf = new Date("2026-08-02T12:00:00.000Z");

  it("uses explicit adjacent rolling 30-day UTC instants", () => {
    expect(resolveContentPlanWindows(asOf)).toEqual({
      asOf: "2026-08-02T12:00:00.000Z",
      current: {
        from: "2026-07-03T12:00:00.000Z",
        to: "2026-08-02T12:00:00.000Z",
      },
      comparison: {
        from: "2026-06-03T12:00:00.000Z",
        to: "2026-07-03T12:00:00.000Z",
      },
    });
  });

  it("deduplicates one source message per topic and separates not-evaluated", () => {
    const result = aggregateContentPlanTopic({
      asOf,
      observations: [
        { sourceUserMessageId: "u1", conversationId: "c1", observedAt: "2026-08-01T00:00:00.000Z", groundingVerdict: "degraded" },
        { sourceUserMessageId: "u1", conversationId: "c1", observedAt: "2026-08-01T00:00:00.000Z", groundingVerdict: "degraded" },
        { sourceUserMessageId: "u2", conversationId: "c2", observedAt: "2026-07-20T00:00:00.000Z", groundingVerdict: "no_support" },
        { sourceUserMessageId: "u3", conversationId: "c3", observedAt: "2026-07-19T00:00:00.000Z", groundingVerdict: "grounded" },
        { sourceUserMessageId: "u4", conversationId: "c4", observedAt: "2026-07-18T00:00:00.000Z", groundingVerdict: "not_evaluated" },
        { sourceUserMessageId: "old", conversationId: "c5", observedAt: "2026-06-20T00:00:00.000Z", groundingVerdict: "grounded" },
        { sourceUserMessageId: "expired", conversationId: "c6", observedAt: "2026-05-01T00:00:00.000Z", groundingVerdict: "no_support" },
      ],
    });

    expect(result.current).toEqual({
      questionCount: 4,
      conversationCount: 4,
      grounding: {
        groundedAnswerCount: 1,
        degradedAnswerCount: 1,
        noSupportAnswerCount: 1,
        notEvaluatedAnswerCount: 1,
        evaluatedAnswerCount: 3,
        reducedOrNoSupportRate: 2 / 3,
      },
    });
    expect(result.comparison.questionCount).toBe(1);
  });

  it("counts a multi-topic source message once report-wide", () => {
    expect(countDistinctReportQuestions([
      { sourceUserMessageId: "u1", observedAt: "2026-08-01T00:00:00.000Z" },
      { sourceUserMessageId: "u1", observedAt: "2026-08-01T00:00:00.000Z" },
      { sourceUserMessageId: "u2", observedAt: "2026-06-20T00:00:00.000Z" },
    ], resolveContentPlanWindows(asOf).current)).toBe(1);
  });

  it("uses deterministic sparse-safe trend rules", () => {
    expect(resolveTopicTrend({ currentQuestionCount: 1, comparisonQuestionCount: 1 })).toBe("insufficient_data");
    expect(resolveTopicTrend({ currentQuestionCount: 2, comparisonQuestionCount: 0 })).toBe("new");
    expect(resolveTopicTrend({ currentQuestionCount: 8, comparisonQuestionCount: 4 })).toBe("rising");
    expect(resolveTopicTrend({ currentQuestionCount: 4, comparisonQuestionCount: 8 })).toBe("falling");
    expect(resolveTopicTrend({ currentQuestionCount: 6, comparisonQuestionCount: 5 })).toBe("steady");
  });

  it("locks evidence bands and low-denominator headline states", () => {
    expect([0, 1, 4, 5, 19, 20].map(resolveEvidenceStrength)).toEqual([
      "none", "low", "low", "medium", "medium", "high",
    ]);
    expect(resolveGroundingHeadlineState({ evaluatedAnswerCount: 0, evaluatedConversationCount: 0 })).toBe("unmeasured");
    expect(resolveGroundingHeadlineState({ evaluatedAnswerCount: 12, evaluatedConversationCount: 4 })).toBe("insufficient_measured_turns");
    expect(resolveGroundingHeadlineState({ evaluatedAnswerCount: 5, evaluatedConversationCount: 5 })).toBe("measured");
  });
});
