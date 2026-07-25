import { describe, expect, it, vi } from "vitest";

import { DefaultConversationEngine } from "@radioso/conversation-engine";
import { WorkbenchReplayRunner } from "../../../src/modules/chat/services/workbenchReplayRunner.js";
import type { RetrievalTurnPort } from "../../../src/modules/chat/services/retrievalTurnDispatch.js";
import type { TurnRouter } from "../../../src/modules/chat/services/turnRouter.js";
import type { TurnSkill } from "../../../src/modules/chat/services/turnOutcome.js";
import type {
  TurnPlanCoordinator,
  TurnPlanInputs,
} from "../../../src/modules/chat/services/turnPlanCoordinator.js";
import type { RetrievalPipelineRequest, RetrievalPipelineResult } from "../../../src/modules/retrieval/public.js";
import { runConversationQualitySuite, type ConversationQualityCase } from "../../../src/modules/eval/suite/index.js";
import { conversationQualityAgentConfig, CQ_AGENT_ID, CQ_WORKSPACE_ID } from "../../fixtures/conversation-quality/index.js";
import { REFUND_POLICY_DOC_ID } from "../../fixtures/conversation-quality/corpus.js";
import { buildReplayInput, createWorkbenchReplayRunnerPort } from "../../../scripts/evalRunnerAdapter.js";
import { createAuditService } from "../../support/fakes.js";

const retrievalResult = (request: RetrievalPipelineRequest): RetrievalPipelineResult =>
  ({
    rewrittenQuery: request.query,
    contexts: [
      {
        chunkId: "chunk-1",
        documentId: REFUND_POLICY_DOC_ID,
        title: "Refund Policy",
        content: "Refunds within 30 days.",
        promptPosition: 0,
        similarity: 0.8,
        fusedScore: 0.8,
        semanticScore: 0.76,
        lexicalScore: 0.9,
        lexicalRankScore: 0.3,
        metadata: {},
      },
    ],
    systemPrompt: "system",
    prompt: "prompt",
    citations: [],
    responseIdentity: request.responseIdentity ?? null,
    responseSettings: {
      citationDisplayEnabled: true,
      suggestedQuestionsEnabled: true,
      suggestedQuestionsCount: 3,
      customInstruction: request.responseBehavior?.customInstruction,
      responseLanguagePolicy: "match_user_question",
    },
    diagnostics: {
      execution: { surface: "assistant", path: "assistant_retrieval", retrievalInvoked: true },
      rewriteStatus: "skipped",
      rerankStatus: "skipped",
      originalCandidateCount: 1,
      rewrittenCandidateCount: 1,
      lexicalCandidateCount: 0,
      normalizedCandidateCount: 1,
      finalContextCount: 1,
      retrievalSkipped: false,
      candidateFallbackApplied: false,
      fallbackApplied: false,
    },
    trace: { traceId: "retrieval-trace", startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), totalDurationMs: 0, stages: [], links: [] },
  }) as unknown as RetrievalPipelineResult;

const retrievalTurn = (): RetrievalTurnPort => ({
  async interpret(request) {
    return {
      request,
      traceStartedAtMs: Date.now(),
      context: { result: {} as never, startedAt: Date.now(), durationMs: 0 },
      interpretation: { startedAt: Date.now(), durationMs: 0 },
    };
  },
  async dispatch(input) {
    return retrievalResult(input.interpreted.request);
  },
});

const answerSkill = (): TurnSkill => ({
  definition: { name: "replay.answer", outcomeKinds: ["replay"] },
  selects: () => true,
  dispatch: (session) => ({
    kind: "replay",
    skillName: "replay.answer",
    outcome: { status: "completed", answer: "Refunds are available within 30 days." },
    stagedContext: session.stagedContext,
    steering: session.directiveSteering?.rules ?? [],
    trace: session.turnTrace,
  }),
  renderer: {
    supports: (outcome) => outcome.kind === "replay",
    render: async (outcome) => ({
      answer: outcome.outcome.answer ?? "",
      skillName: outcome.skillName,
      skillOutcome: outcome.outcome.status,
      skillStatus: outcome.outcome.status,
      citations: [{ documentId: REFUND_POLICY_DOC_ID, chunkId: "chunk-1", title: "Refund Policy" }],
      grounding: "grounded",
      groundingSummary: {
        protocolVersion: 2,
        parseStatus: "valid_v2",
        verdict: "grounded",
        claimCount: 1,
        sourcedClaimCount: 1,
        unsourcedClaimCount: 0,
        invalidSourceCount: 0,
        assertionMismatch: false,
      },
    }),
  },
});

const stubTurnRouter = (): TurnRouter => ({
  async classify() {
    return { route: "retrieval", framing: { isIdentityQuestion: false } };
  },
});

describe("buildReplayInput", () => {
  it("maps history and passes through turn context and the routine start state", () => {
    const evalCase: ConversationQualityCase = {
      id: "c",
      name: "c",
      history: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
      query: "and now?",
      pageContext: {
        pageUrl: "https://example.com/release",
        pageTitle: "Release notes",
        content: "The release is named Blue Heron.",
      },
      clientContextCapabilities: {
        "page.read": {
          available: true,
          mode: "content",
          supportedOperations: ["metadata", "lookup", "summarize"],
        },
      },
      routineStartState: { routineId: "r", path: ["s1"], variables: { email: "a@b.c" }, status: "active" },
      assertions: [],
    };
    const input = buildReplayInput(evalCase, {
      workspaceId: CQ_WORKSPACE_ID,
      agentId: CQ_AGENT_ID,
      baselineAgentConfig: conversationQualityAgentConfig,
    });
    expect(input.query).toBe("and now?");
    expect(input.history.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(input.pageContext).toEqual(evalCase.pageContext);
    expect(input.clientContextCapabilities).toEqual(evalCase.clientContextCapabilities);
    expect(input.routineStartState).toEqual({ routineId: "r", path: ["s1"], variables: { email: "a@b.c" }, status: "active" });
  });
});

describe("conversation-quality suite over the real engine", () => {
  it("threads page-read capability into replay turn planning", async () => {
    const plan = vi.fn(async (_input: TurnPlanInputs) => ({
      status: "failed" as const,
      reason: "invalid_or_error" as const,
    }));
    const turnPlanCoordinator = {
      plan,
      recordBypass: vi.fn(),
    } as unknown as TurnPlanCoordinator;
    const runner = new WorkbenchReplayRunner({
      retrievalTurn: retrievalTurn(),
      auditService: createAuditService(),
      turnSkills: [answerSkill()],
      conversationEngine: new DefaultConversationEngine(),
      turnRouter: stubTurnRouter(),
      turnPlanCoordinator,
    });

    await runner.run({
      workspaceId: CQ_WORKSPACE_ID,
      sourceAgentId: CQ_AGENT_ID,
      baselineAgentConfig: conversationQualityAgentConfig,
      query: "Summarize this page.",
      history: [],
      pageContext: {
        pageTitle: "Release notes",
        content: "The release is named Blue Heron.",
      },
      clientContextCapabilities: {
        "page.read": {
          available: true,
          mode: "content",
          supportedOperations: ["metadata", "lookup", "summarize"],
        },
      },
    });

    expect(plan).toHaveBeenCalledTimes(1);
    expect(plan.mock.calls[0]?.[0].pageReadCapability).toEqual({
      available: true,
      mode: "content",
      supportedOperations: ["metadata", "lookup", "summarize"],
    });
  });

  it("scores a case end-to-end through the runner port and real conversation engine", async () => {
    const runner = new WorkbenchReplayRunner({
      retrievalTurn: retrievalTurn(),
      auditService: createAuditService(),
      turnSkills: [answerSkill()],
      conversationEngine: new DefaultConversationEngine(),
      turnRouter: stubTurnRouter(),
    });

    const port = createWorkbenchReplayRunnerPort(runner, {
      workspaceId: CQ_WORKSPACE_ID,
      agentId: CQ_AGENT_ID,
      baselineAgentConfig: conversationQualityAgentConfig,
    });

    const evalCase: ConversationQualityCase = {
      id: "refund-window",
      name: "refund window",
      query: "How long do I have to get a refund?",
      assertions: [
        { type: "turn_route", route: "retrieval" },
        { type: "turn_uses_skill", skillName: "replay.answer" },
        { type: "turn_grounding_verdict", verdict: "grounded" },
        { type: "answer_cites_document", documentId: REFUND_POLICY_DOC_ID },
        { type: "answer_contains", pattern: "30 days", matchMode: "substring" },
      ],
    };

    const { reports } = await runConversationQualitySuite([evalCase], port, { workspaceId: CQ_WORKSPACE_ID });

    if (reports[0]?.status !== "pass") {
      throw new Error(`expected pass, got ${reports[0]?.status}: ${JSON.stringify(reports[0]?.verdicts, null, 2)}`);
    }
    expect(reports[0]?.status).toBe("pass");
  });
});
