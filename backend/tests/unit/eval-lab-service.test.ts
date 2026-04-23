import { describe, expect, it } from "vitest";

import type { EvalCaseRecord, EvalRunRecord } from "../../src/modules/evals/domain/evalTypes.js";
import { EvalLabService, type EvalRepositoryPort } from "../../src/modules/evals/services/evalLabService.js";
import type { ChatHistoryService } from "../../src/modules/chat/services/chatHistoryService.js";
import type { EvalReplayService } from "../../src/modules/evals/services/evalReplayService.js";

const retrievalInfoStub = {
  candidateCounts: {
    semantic: 0,
    lexical: 0,
    merged: 0,
    final: 0,
  },
  fallbackApplied: false,
  rerankStatus: "skipped",
} as const;

const retrievalInfoWithTrigger = (overrides?: {
  matchedRules?: Array<{ ruleId: string; triggerInstructionPreview: string; matchStrength?: number; reason?: string }>;
  triggerBackoffReason?: "empty_filtered_candidates" | "weak_filtered_support";
}) => ({
  ...retrievalInfoStub,
  triggerAnalysis: {
    status: "applied" as const,
    consideredRules: (overrides?.matchedRules ?? []).map((rule) => ({
      ruleId: rule.ruleId,
      matched: true,
      matchStrength: rule.matchStrength ?? 0.95,
      reason: rule.reason ?? "Matched during replay.",
      triggerInstructionPreview: rule.triggerInstructionPreview,
    })),
    matchedRuleIds: (overrides?.matchedRules ?? []).map((rule) => rule.ruleId),
    unmatchedRuleIds: [],
    matchCount: (overrides?.matchedRules ?? []).length,
    matcherVersion: "test",
  },
  triggerBackoff: overrides?.triggerBackoffReason
    ? {
        applied: true,
        reason: overrides.triggerBackoffReason,
        relaxedRuleIds: ["events-only"],
        restoredCandidateCount: 3,
      }
    : undefined,
});

const createRepositoryStub = (): EvalRepositoryPort => ({
  listDatasets: async () => [],
  createDataset: async () => {
    throw new Error("not used");
  },
  findDatasetById: async () => null,
  listCases: async () => [],
  createCase: async () => {
    throw new Error("not used");
  },
  listRuns: async () => [],
  createRun: async () => {
    throw new Error("not used");
  },
  findRunById: async () => null,
});

describe("EvalLabService", () => {
  it("imports a conversation turn without crashing when historical citations are malformed", async () => {
    const chatHistoryService = {
      getConversation: async () => ({
        conversationId: "conversation-1",
        workspaceId: "workspace-1",
        sourceChannel: null,
        createdAt: "2026-04-02T00:00:00.000Z",
        updatedAt: "2026-04-02T00:00:00.000Z",
        messageCount: 2,
        userMessageCount: 1,
        assistantMessageCount: 1,
        messagesTotal: 2,
        messageWindowOffset: 0,
        messageWindowLimit: 200,
        hasOlderMessages: false,
        messages: [
          {
            id: "user-1",
            role: "user" as const,
            content: "Which cookie name is used for browser sessions?",
            createdAt: "2026-04-02T00:00:00.000Z",
          },
          {
            id: "assistant-1",
            role: "assistant" as const,
            content: "radioso_session",
            createdAt: "2026-04-02T00:00:01.000Z",
            citations: { legacy: true } as any,
            debug: undefined,
          },
        ],
      }),
    } as unknown as ChatHistoryService;

    const service = new EvalLabService(
      createRepositoryStub(),
      chatHistoryService,
      {} as EvalReplayService,
    );

    await expect(
      service.importConversationTurn("workspace-1", {
        conversationId: "conversation-1",
        assistantMessageId: "assistant-1",
      }),
    ).resolves.toMatchObject({
      query: "Which cookie name is used for browser sessions?",
      seededExpectations: {
        expectedDocumentIds: [],
        expectedCitationTitles: [],
      },
      unavailable: ["retrievalTrace", "answerOutcome"],
    });
  });

  it("recomputes comparison outcomes against an explicitly requested baseline run", async () => {
    const evalCase: EvalCaseRecord = {
      id: "case-1",
      datasetId: "dataset-1",
      workspaceId: "workspace-1",
      title: "Case 1",
      sourceType: "manual",
      query: "What is the answer?",
      conversationContext: [],
      expectations: {},
      provenance: {},
      createdAt: "2026-04-04T00:00:00.000Z",
      updatedAt: "2026-04-04T00:00:00.000Z",
    };

    const failedScore = {
      documentMatch: { verdict: "unscored" as const },
      citationMatch: { verdict: "unscored" as const },
      refusalMatch: { verdict: "unscored" as const },
      answerOutcomeMatch: { verdict: "unscored" as const },
      answerContainsMatch: { verdict: "unscored" as const },
      latencyMatch: { verdict: "unscored" as const },
      overallVerdict: "fail" as const,
      reasons: ["Baseline failed."],
    };
    const passedScore = {
      ...failedScore,
      overallVerdict: "pass" as const,
      reasons: [],
    };

    const baseRun: Omit<EvalRunRecord, "id" | "label" | "baselineRunId" | "results" | "summary"> = {
      datasetId: "dataset-1",
      workspaceId: "workspace-1",
      createdByAccountId: null,
      runMetadata: {},
      startedAt: "2026-04-04T00:00:00.000Z",
      completedAt: "2026-04-04T00:00:01.000Z",
    };

    const baselineA: EvalRunRecord = {
      ...baseRun,
      id: "run-a",
      label: "Baseline A",
      baselineRunId: null,
      summary: {
        totalCases: 1,
        passCount: 0,
        failCount: 1,
        skippedCount: 0,
        invalidCount: 0,
        improvementCount: 0,
        regressionCount: 0,
        unchangedCount: 0,
      },
      results: [{
        caseId: "case-1",
        status: "fail",
        score: failedScore,
        diagnostics: {
          retrievalInfo: retrievalInfoStub,
          answerOutcome: "grounded_success",
          answer: "bad",
          latencyMs: 10,
        },
      }],
    };

    const baselineB: EvalRunRecord = {
      ...baseRun,
      id: "run-b",
      label: "Baseline B",
      baselineRunId: null,
      summary: {
        totalCases: 1,
        passCount: 1,
        failCount: 0,
        skippedCount: 0,
        invalidCount: 0,
        improvementCount: 0,
        regressionCount: 0,
        unchangedCount: 0,
      },
      results: [{
        caseId: "case-1",
        status: "pass",
        score: passedScore,
        diagnostics: {
          retrievalInfo: retrievalInfoStub,
          answerOutcome: "grounded_success",
          answer: "good",
          latencyMs: 10,
        },
      }],
    };

    const candidateRun: EvalRunRecord = {
      ...baseRun,
      id: "run-candidate",
      label: "Candidate",
      baselineRunId: "run-b",
      summary: {
        totalCases: 1,
        passCount: 1,
        failCount: 0,
        skippedCount: 0,
        invalidCount: 0,
        improvementCount: 0,
        regressionCount: 0,
        unchangedCount: 1,
      },
      results: [{
        caseId: "case-1",
        status: "pass",
        score: passedScore,
        diagnostics: {
          retrievalInfo: retrievalInfoStub,
          answerOutcome: "grounded_success",
          answer: "good",
          latencyMs: 10,
        },
        comparisonOutcome: "unchanged",
        comparisonReasons: ["Case outcome is unchanged from the baseline run."],
      }],
    };

    const repository: EvalRepositoryPort = {
      ...createRepositoryStub(),
      findRunById: async () => candidateRun,
      listRuns: async () => [candidateRun, baselineB, baselineA],
      listCases: async () => [evalCase],
    };

    const service = new EvalLabService(
      repository,
      {} as ChatHistoryService,
      {} as EvalReplayService,
    );

    await expect(
      service.compareRun("workspace-1", "dataset-1", "run-candidate", "run-a"),
    ).resolves.toMatchObject({
      baselineRunId: "run-a",
      candidateRunId: "run-candidate",
      improvements: 1,
      unchanged: 0,
      regressions: 0,
      unscored: 0,
      cases: [
        expect.objectContaining({
          caseId: "case-1",
          outcome: "improved",
          reasons: ["Case now passes all configured expectations."],
          baselineStatus: "fail",
          candidateStatus: "pass",
        }),
      ],
    });
  });

  it("falls back to the nearest older run when comparing historical runs without an explicit baseline", async () => {
    const evalCase: EvalCaseRecord = {
      id: "case-1",
      datasetId: "dataset-1",
      workspaceId: "workspace-1",
      title: "Case 1",
      sourceType: "manual",
      query: "What changed?",
      conversationContext: [],
      expectations: {},
      provenance: {},
      createdAt: "2026-04-04T00:00:00.000Z",
      updatedAt: "2026-04-04T00:00:00.000Z",
    };

    const failedScore = {
      documentMatch: { verdict: "unscored" as const },
      citationMatch: { verdict: "unscored" as const },
      refusalMatch: { verdict: "unscored" as const },
      answerOutcomeMatch: { verdict: "unscored" as const },
      answerContainsMatch: { verdict: "unscored" as const },
      latencyMatch: { verdict: "unscored" as const },
      overallVerdict: "fail" as const,
      reasons: ["Older baseline failed."],
    };
    const passedScore = {
      ...failedScore,
      overallVerdict: "pass" as const,
      reasons: [],
    };

    const newestRun: EvalRunRecord = {
      id: "run-newest",
      datasetId: "dataset-1",
      workspaceId: "workspace-1",
      label: "Newest",
      baselineRunId: null,
      createdByAccountId: null,
      runMetadata: {},
      summary: {
        totalCases: 1,
        passCount: 1,
        failCount: 0,
        skippedCount: 0,
        invalidCount: 0,
        improvementCount: 0,
        regressionCount: 0,
        unchangedCount: 0,
      },
      results: [{
        caseId: "case-1",
        status: "pass",
        score: passedScore,
        diagnostics: {
          retrievalInfo: retrievalInfoStub,
          answerOutcome: "grounded_success",
          answer: "newest",
          latencyMs: 10,
        },
      }],
      startedAt: "2026-04-06T00:00:00.000Z",
      completedAt: "2026-04-06T00:00:01.000Z",
    };

    const candidateRun: EvalRunRecord = {
      id: "run-candidate",
      datasetId: "dataset-1",
      workspaceId: "workspace-1",
      label: "Candidate",
      baselineRunId: null,
      createdByAccountId: null,
      runMetadata: {},
      summary: {
        totalCases: 1,
        passCount: 1,
        failCount: 0,
        skippedCount: 0,
        invalidCount: 0,
        improvementCount: 0,
        regressionCount: 0,
        unchangedCount: 0,
      },
      results: [{
        caseId: "case-1",
        status: "pass",
        score: passedScore,
        diagnostics: {
          retrievalInfo: retrievalInfoStub,
          answerOutcome: "grounded_success",
          answer: "candidate",
          latencyMs: 10,
        },
      }],
      startedAt: "2026-04-05T00:00:00.000Z",
      completedAt: "2026-04-05T00:00:01.000Z",
    };

    const olderRun: EvalRunRecord = {
      id: "run-older",
      datasetId: "dataset-1",
      workspaceId: "workspace-1",
      label: "Older",
      baselineRunId: null,
      createdByAccountId: null,
      runMetadata: {},
      summary: {
        totalCases: 1,
        passCount: 0,
        failCount: 1,
        skippedCount: 0,
        invalidCount: 0,
        improvementCount: 0,
        regressionCount: 0,
        unchangedCount: 0,
      },
      results: [{
        caseId: "case-1",
        status: "fail",
        score: failedScore,
        diagnostics: {
          retrievalInfo: retrievalInfoStub,
          answerOutcome: "grounded_success",
          answer: "older",
          latencyMs: 10,
        },
      }],
      startedAt: "2026-04-04T00:00:00.000Z",
      completedAt: "2026-04-04T00:00:01.000Z",
    };

    const repository: EvalRepositoryPort = {
      ...createRepositoryStub(),
      findRunById: async () => candidateRun,
      listRuns: async () => [newestRun, candidateRun, olderRun],
      listCases: async () => [evalCase],
    };

    const service = new EvalLabService(
      repository,
      {} as ChatHistoryService,
      {} as EvalReplayService,
    );

    await expect(
      service.compareRun("workspace-1", "dataset-1", "run-candidate"),
    ).resolves.toMatchObject({
      baselineRunId: "run-older",
      candidateRunId: "run-candidate",
      improvements: 1,
      regressions: 0,
      unchanged: 0,
      unscored: 0,
    });
  });

  it("explains regression reasons when trigger decisions and backoff behavior change", async () => {
    const evalCase: EvalCaseRecord = {
      id: "case-trigger",
      datasetId: "dataset-1",
      workspaceId: "workspace-1",
      title: "Upcoming event case",
      sourceType: "manual",
      query: "When is the next conference?",
      conversationContext: [],
      expectations: {},
      provenance: {},
      createdAt: "2026-04-04T00:00:00.000Z",
      updatedAt: "2026-04-04T00:00:00.000Z",
    };

    const passedScore = {
      documentMatch: { verdict: "unscored" as const },
      citationMatch: { verdict: "unscored" as const },
      refusalMatch: { verdict: "unscored" as const },
      answerOutcomeMatch: { verdict: "unscored" as const },
      answerContainsMatch: { verdict: "unscored" as const },
      latencyMatch: { verdict: "unscored" as const },
      overallVerdict: "pass" as const,
      reasons: [],
    };
    const failedScore = {
      ...passedScore,
      overallVerdict: "fail" as const,
      reasons: ["Expected citation titles were not all present."],
    };

    const baselineRun: EvalRunRecord = {
      id: "run-base",
      datasetId: "dataset-1",
      workspaceId: "workspace-1",
      label: "Baseline",
      baselineRunId: null,
      createdByAccountId: null,
      runMetadata: {},
      summary: {
        totalCases: 1,
        passCount: 1,
        failCount: 0,
        skippedCount: 0,
        invalidCount: 0,
        improvementCount: 0,
        regressionCount: 0,
        unchangedCount: 0,
      },
      results: [{
        caseId: "case-trigger",
        status: "pass",
        score: passedScore,
        diagnostics: {
          retrievalInfo: retrievalInfoWithTrigger({
            matchedRules: [{ ruleId: "events-only", triggerInstructionPreview: "Enact when the user is asking about upcoming events." }],
          }),
          answerOutcome: "grounded_success",
          answer: "conference",
          latencyMs: 10,
        },
      }],
      startedAt: "2026-04-04T00:00:00.000Z",
      completedAt: "2026-04-04T00:00:01.000Z",
    };

    const candidateRun: EvalRunRecord = {
      id: "run-candidate",
      datasetId: "dataset-1",
      workspaceId: "workspace-1",
      label: "Candidate",
      baselineRunId: "run-base",
      createdByAccountId: null,
      runMetadata: {},
      summary: {
        totalCases: 1,
        passCount: 0,
        failCount: 1,
        skippedCount: 0,
        invalidCount: 0,
        improvementCount: 0,
        regressionCount: 1,
        unchangedCount: 0,
      },
      results: [{
        caseId: "case-trigger",
        status: "fail",
        score: failedScore,
        diagnostics: {
          retrievalInfo: retrievalInfoWithTrigger({
            matchedRules: [],
            triggerBackoffReason: "weak_filtered_support",
          }),
          answerOutcome: "grounded_success",
          answer: "different",
          latencyMs: 10,
        },
      }],
      startedAt: "2026-04-05T00:00:00.000Z",
      completedAt: "2026-04-05T00:00:01.000Z",
    };

    const repository: EvalRepositoryPort = {
      ...createRepositoryStub(),
      findRunById: async () => candidateRun,
      listRuns: async () => [candidateRun, baselineRun],
      listCases: async () => [evalCase],
    };

    const service = new EvalLabService(repository, {} as ChatHistoryService, {} as EvalReplayService);

    await expect(
      service.compareRun("workspace-1", "dataset-1", "run-candidate", "run-base"),
    ).resolves.toMatchObject({
      cases: [
        expect.objectContaining({
          caseId: "case-trigger",
          outcome: "regressed",
          reasons: expect.arrayContaining([
            'Trigger decision changed from rule events-only ("Enact when the user is asking about upcoming events.") to no enacted trigger rules.',
            "Trigger backoff changed from none to weak_filtered_support.",
            "Expected citation titles were not all present.",
          ]),
        }),
      ],
    });
  });

  it("surfaces trigger confidence and rationale diffs even when the same rule stays enacted", async () => {
    const passedScore = {
      documentMatch: { verdict: "unscored" as const },
      citationMatch: { verdict: "unscored" as const },
      refusalMatch: { verdict: "unscored" as const },
      answerOutcomeMatch: { verdict: "unscored" as const },
      answerContainsMatch: { verdict: "unscored" as const },
      latencyMatch: { verdict: "unscored" as const },
      overallVerdict: "pass" as const,
      reasons: [],
    };

    const evalCase: EvalCaseRecord = {
      id: "case-trigger-strength",
      datasetId: "dataset-1",
      workspaceId: "workspace-1",
      title: "Trigger diff case",
      sourceType: "manual",
      query: "When is the next conference?",
      conversationContext: [],
      expectations: {},
      provenance: {},
      createdAt: "2026-04-05T00:00:00.000Z",
      updatedAt: "2026-04-05T00:00:00.000Z",
    };

    const baselineRun: EvalRunRecord = {
      id: "run-trigger-base",
      datasetId: "dataset-1",
      workspaceId: "workspace-1",
      label: "Baseline trigger run",
      baselineRunId: null,
      createdByAccountId: null,
      runMetadata: {},
      summary: {
        totalCases: 1,
        passCount: 1,
        failCount: 0,
        skippedCount: 0,
        invalidCount: 0,
        improvementCount: 0,
        regressionCount: 0,
        unchangedCount: 1,
      },
      results: [{
        caseId: "case-trigger-strength",
        status: "pass",
        score: passedScore,
        diagnostics: {
          retrievalInfo: retrievalInfoWithTrigger({
            matchedRules: [
              {
                ruleId: "events-only",
                triggerInstructionPreview: "Enact when the user is asking about upcoming events.",
                matchStrength: 0.95,
                reason: "The query explicitly asks about the next event.",
              },
            ],
          }),
          answerOutcome: "grounded_success",
          answer: "same",
          latencyMs: 10,
        },
      }],
      startedAt: "2026-04-05T00:00:00.000Z",
      completedAt: "2026-04-05T00:00:01.000Z",
    };

    const candidateRun: EvalRunRecord = {
      id: "run-trigger-candidate",
      datasetId: "dataset-1",
      workspaceId: "workspace-1",
      label: "Candidate trigger run",
      baselineRunId: "run-trigger-base",
      createdByAccountId: null,
      runMetadata: {},
      summary: {
        totalCases: 1,
        passCount: 1,
        failCount: 0,
        skippedCount: 0,
        invalidCount: 0,
        improvementCount: 0,
        regressionCount: 0,
        unchangedCount: 1,
      },
      results: [{
        caseId: "case-trigger-strength",
        status: "pass",
        score: passedScore,
        diagnostics: {
          retrievalInfo: retrievalInfoWithTrigger({
            matchedRules: [
              {
                ruleId: "events-only",
                triggerInstructionPreview: "Match follow-up turns that still ask about upcoming events.",
                matchStrength: 0.88,
                reason: "The resolved follow-up still looks event-oriented.",
              },
            ],
          }),
          answerOutcome: "grounded_success",
          answer: "same",
          latencyMs: 10,
        },
      }],
      startedAt: "2026-04-05T00:00:02.000Z",
      completedAt: "2026-04-05T00:00:03.000Z",
    };

    const repository: EvalRepositoryPort = {
      ...createRepositoryStub(),
      findRunById: async () => candidateRun,
      listRuns: async () => [candidateRun, baselineRun],
      listCases: async () => [evalCase],
    };

    const service = new EvalLabService(repository, {} as ChatHistoryService, {} as EvalReplayService);

    const comparison = await service.compareRun("workspace-1", "dataset-1", "run-trigger-candidate", "run-trigger-base");

    expect(comparison).toMatchObject({
      cases: [{
        caseId: "case-trigger-strength",
        outcome: "unchanged",
        reasons: expect.arrayContaining([
          'Trigger confidence for rule events-only ("Match follow-up turns that still ask about upcoming events.") changed from 0.95 to 0.88.',
          'Trigger rationale changed for rule events-only ("Match follow-up turns that still ask about upcoming events.").',
          "Case outcome is unchanged from the baseline run.",
        ]),
      }],
    });
    expect(comparison.cases[0]?.reasons).not.toEqual(
      expect.arrayContaining([expect.stringContaining("Trigger decision changed")]),
    );
  });
});
