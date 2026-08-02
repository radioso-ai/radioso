import { describe, expect, it } from "vitest";

import {
  CONTENT_PLAN_ENRICHMENT_STATES,
  CONTENT_PLAN_PROJECTION_STATES,
  CONTENT_PLAN_RECOMMENDATION_ACTIONS,
  contentPlanDetailSchema,
  contentPlanListQuerySchema,
  contentPlanPageSchema,
  contentPlanTopicTurnsQuerySchema,
} from "../../src/modules/contentPlanning/contracts/index.js";

const projection = {
  state: "ready" as const,
  processedThrough: "2026-08-02T12:00:00.000Z",
  processingLagSeconds: 4,
  pendingEmbeddingCount: 1,
  pendingAssignmentCount: 2,
  pendingEnrichmentTopicCount: 3,
  processedCount: null,
  totalCount: null,
  embeddingSpaceFingerprint: "space-v1",
  reason: null,
};

const topic = {
  id: "11111111-1111-4111-8111-111111111111",
  lifecycle: "mature" as const,
  label: "Enterprise SSO",
  description: "Questions about configuring enterprise identity providers.",
  labelState: "ready" as const,
  demand: {
    currentQuestionCount: 8,
    comparisonQuestionCount: 3,
    currentConversationCount: 6,
    comparisonConversationCount: 3,
    currentShare: 0.4,
    absoluteChange: 5,
    trend: "rising" as const,
  },
  grounding: {
    groundedAnswerCount: 1,
    degradedAnswerCount: 2,
    noSupportAnswerCount: 3,
    notEvaluatedAnswerCount: 2,
    evaluatedAnswerCount: 6,
    reducedOrNoSupportRate: 5 / 6,
    headlineState: "measured" as const,
  },
  evidence: {
    strength: "medium" as const,
    evaluatedConversationCount: 5,
    activeGapConversationCount: 4,
  },
  opportunity: {
    credible: true,
    priorityReasons: ["active_no_support", "rising_demand"] as const,
  },
  recommendation: {
    action: "add_content" as const,
    state: "ready" as const,
    rationale: "Several visitors could not find setup guidance.",
    suggestedTitle: "Configure enterprise SSO",
    questionsToAnswer: ["Which providers are supported?", "How is SSO configured?", "How is it tested?"],
    suggestedShape: "guide" as const,
    evidenceStatement: "Based on 5 evaluated conversations.",
    factsMustBeVerified: true as const,
  },
  corpusEvidence: {
    state: "ready" as const,
    relatedDocumentCount: 0,
    actionRuleVersion: 1 as const,
  },
  affected: { agentCount: 2, channelCount: 1 },
  updatedAt: "2026-08-02T12:00:00.000Z",
};

describe("content planning HTTP contracts", () => {
  it("locks the bounded list and member-turn query defaults", () => {
    expect(contentPlanListQuerySchema.parse({})).toEqual({
      view: "opportunities",
      limit: 25,
    });
    expect(contentPlanListQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(contentPlanListQuerySchema.safeParse({ view: "unknown" }).success).toBe(false);

    expect(contentPlanTopicTurnsQuerySchema.parse({})).toEqual({
      window: "current",
      page: 1,
      pageSize: 25,
    });
    expect(contentPlanTopicTurnsQuerySchema.safeParse({ page: 0 }).success).toBe(false);
  });

  it("keeps not-evaluated answers separate from the three measured verdict counts", () => {
    const parsed = contentPlanPageSchema.parse({
      range: "30d",
      window: { from: "2026-07-03T12:00:00.000Z", to: "2026-08-02T12:00:00.000Z" },
      comparisonWindow: { from: "2026-06-03T12:00:00.000Z", to: "2026-07-03T12:00:00.000Z" },
      asOf: "2026-08-02T12:00:00.000Z",
      projection,
      summary: {
        questionCount: 20,
        conversationCount: 14,
        matureTopicCount: 2,
        emergingQuestionCount: 1,
        opportunityCount: 1,
        grounding: {
          evaluatedAnswerCount: 15,
          groundedAnswerCount: 8,
          degradedAnswerCount: 4,
          noSupportAnswerCount: 3,
          notEvaluatedAnswerCount: 5,
          reducedOrNoSupportRate: 7 / 15,
          headlineState: "measured",
        },
      },
      rankingVersion: 1,
      recommendedTopicId: topic.id,
      items: [topic],
      emerging: [{
        observationId: "22222222-2222-4222-8222-222222222222",
        question: "Can I use a hardware security key?",
        sourceAvailable: true,
        conversationId: "33333333-3333-4333-8333-333333333333",
        assistantMessageId: "44444444-4444-4444-8444-444444444444",
        questionCount: 1,
        conversationCount: 1,
        observedAt: "2026-08-02T11:00:00.000Z",
        state: "emerging",
      }],
      nextCursor: null,
    });

    expect(parsed.items[0]?.grounding).toMatchObject({
      groundedAnswerCount: 1,
      degradedAnswerCount: 2,
      noSupportAnswerCount: 3,
      notEvaluatedAnswerCount: 2,
    });
    expect(Object.keys(parsed.items[0]?.grounding ?? {})).not.toContain("notEvaluatedVerdict");
  });

  it("keeps detail evidence bounded and rejects vector/provider leakage", () => {
    const detail = {
      asOf: "2026-08-02T12:00:00.000Z",
      window: { from: "2026-07-03T12:00:00.000Z", to: "2026-08-02T12:00:00.000Z" },
      comparisonWindow: { from: "2026-06-03T12:00:00.000Z", to: "2026-07-03T12:00:00.000Z" },
      projection,
      canonicalTopicId: topic.id,
      redirectedFromTopicId: null,
      topic,
      decision: {
        action: "add_content",
        actionState: "ready",
        reasons: ["No related document cleared the relevance floor."],
      },
      representativeQuestions: [{
        observationId: "22222222-2222-4222-8222-222222222222",
        question: "Does it support Okta?",
        sourceAvailable: true,
        conversationId: "33333333-3333-4333-8333-333333333333",
        userMessageId: "55555555-5555-4555-8555-555555555555",
        assistantMessageId: "44444444-4444-4444-8444-444444444444",
        observedAt: "2026-08-02T11:00:00.000Z",
        groundingVerdict: "no_support",
      }],
      relatedDocuments: [],
      affectedAgents: [],
      affectedChannels: [],
    };

    expect(contentPlanDetailSchema.parse(detail).canonicalTopicId).toBe(topic.id);
    expect(contentPlanDetailSchema.safeParse({ ...detail, vector: [0.1, 0.2] }).success).toBe(false);
    expect(contentPlanDetailSchema.safeParse({ ...detail, providerResponse: {} }).success).toBe(false);
  });

  it("publishes closed enum sets for clients", () => {
    expect(CONTENT_PLAN_PROJECTION_STATES).toEqual([
      "bootstrapping",
      "ready",
      "updating",
      "delayed",
      "reprojecting",
      "degraded",
      "budget_paused",
    ]);
    expect(CONTENT_PLAN_RECOMMENDATION_ACTIONS).toEqual([
      "add_content",
      "review_existing_content",
      "investigate_retrieval",
      "monitor",
    ]);
    expect(CONTENT_PLAN_ENRICHMENT_STATES).toContain("outside_analysis_cap");
  });
});
