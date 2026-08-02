import { describe, expect, it } from "vitest";

import {
  compareContentPlanOpportunities,
  deriveContentPlanOpportunity,
  selectRecommendationAction,
} from "../../src/modules/contentPlanning/domain/opportunityPolicy.js";

describe("content planning opportunity policy v1", () => {
  it("requires a mature topic and active gap evidence from two conversations", () => {
    expect(deriveContentPlanOpportunity({
      mature: true,
      evidence: [
        { conversationId: "c1", verdict: "no_support", remediationActive: true },
        { conversationId: "c2", verdict: "degraded", remediationActive: true },
        { conversationId: "c3", verdict: "no_support", remediationActive: false },
        { conversationId: "c4", verdict: "not_evaluated", remediationActive: true },
      ],
    })).toEqual({
      credible: true,
      activeNoSupportConversationCount: 1,
      activeDegradedConversationCount: 1,
      activeGapConversationCount: 2,
    });
    expect(deriveContentPlanOpportunity({
      mature: false,
      evidence: [
        { conversationId: "c1", verdict: "no_support", remediationActive: true },
        { conversationId: "c2", verdict: "no_support", remediationActive: true },
      ],
    }).credible).toBe(false);
  });

  it("orders no-support, degraded, demand, trend, then stable topic id", () => {
    const rows = [
      { topicId: "c", activeNoSupportConversationCount: 2, activeDegradedConversationCount: 1, currentConversationCount: 10, trend: "steady" as const },
      { topicId: "b", activeNoSupportConversationCount: 2, activeDegradedConversationCount: 2, currentConversationCount: 4, trend: "falling" as const },
      { topicId: "a", activeNoSupportConversationCount: 2, activeDegradedConversationCount: 2, currentConversationCount: 4, trend: "falling" as const },
      { topicId: "d", activeNoSupportConversationCount: 1, activeDegradedConversationCount: 8, currentConversationCount: 20, trend: "new" as const },
    ];

    expect(rows.sort(compareContentPlanOpportunities).map((row) => row.topicId)).toEqual(["a", "b", "c", "d"]);
  });

  it("selects monitor and add-content deterministically", () => {
    expect(selectRecommendationAction({ credibleGap: false, corpus: { state: "unavailable", documents: [] } })).toBe("monitor");
    expect(selectRecommendationAction({ credibleGap: true, corpus: { state: "ready", documents: [] } })).toBe("add_content");
  });

  it("selects investigate when relevant pre-existing content was generally missed", () => {
    expect(selectRecommendationAction({
      credibleGap: true,
      corpus: {
        state: "ready",
        documents: [{
          possibleRelevance: 0.84,
          existedBeforeGap: true,
          retrievedByGapAnswers: false,
          citedByGapAnswers: false,
          changedAfterGap: false,
        }],
      },
    })).toBe("investigate_retrieval");
  });

  it("selects review for retrieved-insufficient or newly changed content", () => {
    expect(selectRecommendationAction({
      credibleGap: true,
      corpus: {
        state: "ready",
        documents: [{
          possibleRelevance: 0.8,
          existedBeforeGap: true,
          retrievedByGapAnswers: true,
          citedByGapAnswers: false,
          changedAfterGap: false,
        }],
      },
    })).toBe("review_existing_content");
    expect(selectRecommendationAction({
      credibleGap: true,
      corpus: {
        state: "ready",
        documents: [{
          possibleRelevance: 0.8,
          existedBeforeGap: false,
          retrievedByGapAnswers: false,
          citedByGapAnswers: false,
          changedAfterGap: true,
        }],
      },
    })).toBe("review_existing_content");
  });

  it("returns no action when corpus evidence is unavailable", () => {
    expect(selectRecommendationAction({ credibleGap: true, corpus: { state: "unavailable", documents: [] } })).toBeNull();
  });
});
