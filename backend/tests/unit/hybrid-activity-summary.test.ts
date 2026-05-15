import { describe, expect, it } from "vitest";

import { ActivitySummaryPresenter } from "../../src/modules/retrieval/services/activitySummaryPresenter.js";

describe("hybrid activity summary", () => {
  it("shapes bounded activity summary information from execution diagnostics", () => {
    const presenter = new ActivitySummaryPresenter();

    const result = presenter.present({
      rewriteStatus: "applied",
      rerankStatus: "applied",
      originalCandidateCount: 4,
      rewrittenCandidateCount: 2,
      lexicalCandidateCount: 3,
      normalizedCandidateCount: 5,
      finalContextCount: 3,
      candidateFallbackApplied: false,
      fallbackApplied: true,
      rewriteEligible: true,
      rewriteRan: true,
      materialDisagreement: false,
      continuityDecision: "reused",
      parsedQuery: {
        originalQuery: "retreats in Estonia",
        semanticQuery: "retreats",
        lexicalQuery: "retreats",
        constraints: [],
      },
      appliedConstraints: [
        {
          signalKey: "metadata.category",
          mode: "hard_filter",
          outcome: "relaxed",
          summary: "category equals event",
        },
      ],
      triggerAnalysis: {
        status: "applied",
        consideredRules: [
          {
            ruleId: "events-only",
            matched: true,
            matchStrength: 0.92,
            reason: "The query is about an upcoming event.",
            triggerInstructionPreview: "Enact for upcoming events.",
          },
        ],
        matchedRuleIds: ["events-only"],
        unmatchedRuleIds: [],
        matchCount: 1,
        matcherVersion: "test",
      },
      triggerBackoff: {
        applied: true,
        reason: "empty_filtered_candidates",
        relaxedRuleIds: ["events-only"],
        restoredCandidateCount: 3,
      },
    });

    expect(result).toMatchObject({
      parsedQuery: {
        originalQuery: "retreats in Estonia",
        semanticQuery: "retreats",
        lexicalQuery: "retreats",
        constraintSummary: [],
      },
      candidateCounts: {
        semantic: 6,
        lexical: 3,
        merged: 5,
        final: 3,
      },
      appliedConstraints: [
        {
          signalKey: "metadata.category",
          mode: "hard_filter",
          outcome: "relaxed",
          summary: "category equals event",
        },
      ],
      fallbackApplied: true,
      rerankStatus: "applied",
      rewrite: {
        status: "applied",
        eligible: true,
        ran: true,
        materialDisagreement: false,
        continuityDecision: "reused",
        rejectionReason: undefined,
        fallbackReason: undefined,
      },
      triggerAnalysis: {
        status: "applied",
        consideredRules: [
          {
            ruleId: "events-only",
            matched: true,
            matchStrength: 0.92,
            reason: "The query is about an upcoming event.",
            triggerInstructionPreview: "Enact for upcoming events.",
          },
        ],
        matchedRuleIds: ["events-only"],
        unmatchedRuleIds: [],
        matchCount: 1,
        matcherVersion: "test",
      },
      triggerBackoff: {
        applied: true,
        reason: "empty_filtered_candidates",
        relaxedRuleIds: ["events-only"],
        restoredCandidateCount: 3,
      },
    });
    expect(result.resolvedSteps).toEqual([]);
  });

  it("includes execution metadata when a caller supplies the capability surface", () => {
    const presenter = new ActivitySummaryPresenter();

    const result = presenter.present(
      {
        rewriteStatus: "skipped",
        rerankStatus: "skipped",
        originalCandidateCount: 0,
        rewrittenCandidateCount: 0,
        lexicalCandidateCount: 0,
        normalizedCandidateCount: 0,
        finalContextCount: 0,
        candidateFallbackApplied: false,
        fallbackApplied: false,
      },
      {
        execution: {
          surface: "mcp_capability",
          path: "mcp_grounded_answer",
          retrievalInvoked: true,
        },
      },
    );

    expect(result.execution).toEqual({
      surface: "mcp_capability",
      path: "mcp_grounded_answer",
      retrievalInvoked: true,
    });
  });
});
