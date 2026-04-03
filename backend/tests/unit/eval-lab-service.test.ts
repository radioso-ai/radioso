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
});
