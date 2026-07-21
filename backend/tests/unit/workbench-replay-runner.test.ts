import { describe, expect, it, vi } from "vitest";

import { DefaultConversationEngine } from "@radioso/conversation-engine";
import type {
  AttemptRoutineInput,
  ConversationEngine,
  ProcessTurnInput,
  ProcessTurnResult,
} from "@radioso/conversation-contract";
import type { ConversationAgent } from "../../src/modules/agents/domain.js";
import { projectInternalAgentConfig } from "../../src/modules/agents/agentConfig.js";
import { WorkbenchReplayRunner } from "../../src/modules/chat/services/workbenchReplayRunner.js";
import type { ChatRoutineProvider } from "../../src/modules/chat/services/chatService.js";
import type { ChatAnswerPresenter } from "../../src/modules/chat/services/chatAnswerPresenter.js";
import type { MessageRecord } from "../../src/db/repositories/messageRepository.js";
import type { TurnRouter } from "../../src/modules/chat/services/turnRouter.js";
import type { ChatConversationTurnInterpreter } from "../../src/modules/chat/services/conversationTurnInterpreter.js";
import type { RetrievalTurnPort } from "../../src/modules/chat/services/retrievalTurnDispatch.js";
import type { TurnSkill } from "../../src/modules/chat/services/turnOutcome.js";
import type { AgentSkillTurnSkillProvider } from "../../src/modules/chat/services/agentSkillTurnSkillProvider.js";
import type { ConversationTurnInterpreterInput } from "../../src/modules/chat/services/conversationTurnInterpreter.js";
import { createRouteScopedDirectiveSteering } from "../../src/modules/chat/services/routeScopedDirectiveSteering.js";
import {
  TurnPlanCoordinator,
  createTurnPlanningGate,
} from "../../src/modules/chat/services/turnPlanCoordinator.js";
import { TurnPlanService } from "../../src/modules/chat/services/turnPlanService.js";
import { DefaultAllowCapabilityPolicy } from "../../src/shared/domain/capabilityPolicy.js";
import type { ResponseLanguageDetectorInput } from "../../src/shared/services/responseLanguageDetector.js";
import type { RetrievalPipelineRequest, RetrievalPipelineResult } from "../../src/modules/retrieval/public.js";
import { createAuditService } from "../support/fakes.js";

const emptyTrace = () => {
  const now = new Date().toISOString();
  return { traceId: "t", startedAt: now, completedAt: now, totalDurationMs: 0, stages: [], links: [] };
};

// Stubs sufficient for the runner's routine wiring — the runner only forwards these to
// the (faked) engine, which is what we assert against.
const routineProviderStub = (): ChatRoutineProvider => ({
  async forTurn() {
    return { activator: {} as never, runner: {} as never };
  },
});
const chatGatewayStub = () => ({ answer: async () => "" });
const presenterStub = (): ChatAnswerPresenter => {
  const present = (answer: string) => ({
    answer,
    skillName: "routine",
    skillOutcome: "completed",
    skillStatus: "completed",
  });
  return {
    presentNonRetrievalAnswer: present,
    presentRoutineAnswer: (answer: string) => present(answer),
  } as unknown as ChatAnswerPresenter;
};

const agent = (): ConversationAgent => ({
  id: "agent-1",
  workspaceId: "ws-1",
  name: "Support",
  createdAt: new Date(0),
  updatedAt: new Date(0),
  customInstruction: "Answer from the operator baseline.",
  suggestedQuestionsEnabled: true,
  assistantLinkUtmEnabled: true,
  citationDisplayEnabled: true,
  contactRequestsEnabled: true,
  webhookExportsEnabled: true,
  contactRequestDelivery: { recipientEmails: ["owner@example.com"], webhook: null },
  retrievalEnabled: true,
  sourceScope: { mode: "all" },
  skillSettings: {},
  logo: null,
  theme: {
    brand: "#000000",
    brandText: "#ffffff",
    surface: "#ffffff",
    text: "#000000",
  },
  branding: {
    hidePoweredBy: false,
    privacyPolicyUrl: null,
  },
  greetingInstruction: "",
  assistantDefaultLocale: null,
  proactiveGreetingEnabled: false,
  chatModelOverride: {
    provider: "openai",
    model: "gpt-5-mini",
  },
  surfaceSettings: {
    authenticatedChat: { enabled: true },
    anonymousChat: { enabled: false, token: null },
    websiteEmbed: {
      enabled: false,
      token: null,
      allowedOrigins: [],
      launcherLabel: "Chat",
      launcherPosition: "bottom-right",
      theme: {
        brand: "#000000",
        brandText: "#ffffff",
        surface: "#ffffff",
        text: "#000000",
      },
      copy: {},
      expertOverrides: {},
    },
    extensions: {},
  },
  authoredDirectives: [],
});

const retrievalResult = (request: RetrievalPipelineRequest): RetrievalPipelineResult => {
  const now = new Date().toISOString();
  return {
    rewrittenQuery: request.query,
    contexts: [{
      chunkId: "chunk-1",
      documentId: "doc-1",
      title: "Refund Policy",
      content: "Refunds take five days.",
      promptPosition: 0,
      similarity: 0.8,
      fusedScore: 0.8,
      semanticScore: 0.76,
      lexicalScore: 0.9,
      lexicalRankScore: 0.3,
      metadata: { dateFrom: "2026-08-10", dateTo: "2026-08-10" },
    }],
    systemPrompt: `system:${request.responseBehavior?.customInstruction ?? ""}`,
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
      execution: {
        surface: "assistant",
        path: "assistant_retrieval",
        retrievalInvoked: true,
      },
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
    trace: {
      traceId: "retrieval-trace",
      startedAt: now,
      completedAt: now,
      totalDurationMs: 0,
      stages: [],
      links: [],
    },
  } as unknown as RetrievalPipelineResult;
};

const retrievalTurn = (capturedRequests: RetrievalPipelineRequest[]): RetrievalTurnPort => ({
  async interpret(request) {
    capturedRequests.push(request);
    return {
      request,
      traceStartedAtMs: Date.now(),
      context: { result: {} as never, startedAt: Date.now(), durationMs: 0 },
      interpretation: {
        startedAt: Date.now(),
        durationMs: 0,
      },
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
    outcome: { status: "completed", answer: `Answered with ${session.agent.customInstruction}` },
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
      citations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Refund Policy" }],
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

const stubTurnRouter = (route: "retrieval" | "direct" = "retrieval"): TurnRouter => ({
  async classify() {
    return { route, framing: { isIdentityQuestion: false } };
  },
});

describe("WorkbenchReplayRunner", () => {
  it("runs a replay through the non-streaming engine and returns answer, citations, trace, and resolved config without repository writes", async () => {
    const capturedRequests: RetrievalPipelineRequest[] = [];
    const classify = vi.fn(async () => ({ route: "retrieval" as const, framing: { isIdentityQuestion: false } }));
    const runner = new WorkbenchReplayRunner({
      retrievalTurn: retrievalTurn(capturedRequests),
      auditService: createAuditService(),
      turnSkills: [answerSkill()],
      conversationEngine: new DefaultConversationEngine(),
      // Replay must route through the same classifier as the live turn, not the
      // legacy selection strategy (Coach/preview fidelity).
      turnRouter: { classify },
    });

    const result = await runner.run({
      workspaceId: "ws-1",
      sourceAgentId: "agent-1",
      baselineAgentConfig: projectInternalAgentConfig(agent()),
      agentConfigOverride: {
        customInstruction: "Replay override.",
      },
      query: "How long do refunds take?",
      history: [],
      usageAttribution: { surface: "eval", requestId: "run-123" },
    });

    expect(result.answer).toBe("Answered with Replay override.");
    expect(result.citations).toEqual([{ documentId: "doc-1", chunkId: "chunk-1", title: "Refund Policy" }]);
    expect(result.groundingSummary).toMatchObject({ verdict: "grounded", parseStatus: "valid_v2" });
    expect(result.turnTrace?.spine.stages.map((stage) => stage.kind)).toEqual([
      "message",
      "gather",
      "turn_interpretation",
      "retrieval_fanout",
      "directive_match",
      "skill_selection",
      "skill_dispatch",
      "compose",
    ]);
    expect(result.resolvedConfig).toMatchObject({
      composedInstructions: "system:Replay override.",
      modelProvider: "openai",
      modelId: "gpt-5-mini",
      retrievedChunks: [{
        chunkId: "chunk-1",
        documentId: "doc-1",
        title: "Refund Policy",
        rank: 0,
        similarity: 0.8,
        fusedScore: 0.8,
        semanticScore: 0.76,
        lexicalScore: 0.9,
        lexicalRankScore: 0.3,
        metadata: { dateFrom: "2026-08-10", dateTo: "2026-08-10" },
      }],
    });
    expect(capturedRequests[0]?.history).toEqual([]);
    expect(classify).toHaveBeenCalledWith(expect.objectContaining({
      usageContext: expect.objectContaining({ surface: "eval", requestId: "run-123" }),
    }));
  });

  it("shares live turn interpretation, rewrite, response-language, and retrieval override assembly", async () => {
    const capturedRequests: RetrievalPipelineRequest[] = [];
    const rewriteProposal = {
      rewrittenQuery: "refund processing time",
      semanticQuery: "refund processing time",
      lexicalQuery: "refund processing time",
      responseLanguagePolicy: "match_user_question" as const,
      turnKind: "fresh_subject" as const,
      relatedEntities: [],
      unresolved: false,
      confidence: 0.9,
    };
    const classify = vi.fn(async () => ({
      route: "direct" as const,
      framing: { isIdentityQuestion: false },
    }));
    const interpretChatTurn = vi.fn(async (_input: ConversationTurnInterpreterInput) => ({
      route: "retrieval" as const,
      framing: { isIdentityQuestion: false },
      rewriteProposal,
    }));
    const detect = vi.fn(async (_input: ResponseLanguageDetectorInput) => ({
      responseLanguage: "Estonian",
    }));
    const runner = new WorkbenchReplayRunner({
      retrievalTurn: retrievalTurn(capturedRequests),
      auditService: createAuditService(),
      turnSkills: [answerSkill()],
      conversationEngine: new DefaultConversationEngine(),
      turnRouter: { classify },
      turnInterpreter: { interpretChatTurn },
      responseLanguageDetector: { detect },
    });

    await runner.run({
      workspaceId: "ws-1",
      sourceAgentId: "agent-1",
      baselineAgentConfig: projectInternalAgentConfig(agent()),
      query: "Kui kaua tagasimakse aega võtab?",
      history: [],
      retrievalSettingsOverride: { vectorTopK: 9 },
      usageAttribution: { surface: "eval", requestId: "run-123" },
    });

    expect(classify).not.toHaveBeenCalled();
    expect(capturedRequests[0]).toMatchObject({
      query: "Kui kaua tagasimakse aega võtab?",
      responseLanguage: "Estonian",
      precomputedRewriteProposal: rewriteProposal,
      retrievalSettingsOverride: { vectorTopK: 9 },
      usageContext: expect.objectContaining({ surface: "eval", requestId: "run-123" }),
    });
    expect(interpretChatTurn).toHaveBeenCalledWith(expect.objectContaining({
      usageAttribution: { surface: "eval", requestId: "run-123" },
    }));
    expect(detect).toHaveBeenCalledWith(expect.objectContaining({
      usageContext: expect.objectContaining({ surface: "eval", requestId: "run-123" }),
    }));
  });

  it("threads the frozen conversation summary (#866) into the prepared session", async () => {
    const seen: { value?: string; called: boolean } = { called: false };
    const summarySkill: TurnSkill = {
      definition: { name: "replay.answer", outcomeKinds: ["replay"] },
      selects: () => true,
      dispatch: (session) => {
        seen.value = session.conversationSummary;
        seen.called = true;
        return {
          kind: "replay",
          skillName: "replay.answer",
          outcome: { status: "completed", answer: `summary:${session.conversationSummary ?? "none"}` },
          stagedContext: session.stagedContext,
          steering: session.directiveSteering?.rules ?? [],
          trace: session.turnTrace,
        };
      },
      renderer: {
        supports: (outcome) => outcome.kind === "replay",
        render: async (outcome) => ({
          answer: outcome.outcome.answer ?? "",
          skillName: outcome.skillName,
          skillOutcome: outcome.outcome.status,
          skillStatus: outcome.outcome.status,
        }),
      },
    };
    const runner = new WorkbenchReplayRunner({
      retrievalTurn: retrievalTurn([]),
      auditService: createAuditService(),
      turnSkills: [summarySkill],
      conversationEngine: new DefaultConversationEngine(),
      turnRouter: stubTurnRouter(),
    });

    const result = await runner.run({
      workspaceId: "ws-1",
      sourceAgentId: "agent-1",
      baselineAgentConfig: projectInternalAgentConfig(agent()),
      query: "How long do refunds take?",
      history: [],
      conversationSummary: "The buyer already returned the item last week.",
    });

    expect(seen.value).toBe("The buyer already returned the item last week.");
    expect(result.answer).toBe("summary:The buyer already returned the item last week.");
    expect(result.resolvedConfig.conversationSummary).toBe(
      "The buyer already returned the item last week.",
    );
  });

  it("passes the frozen conversation summary into replay turn interpretation", async () => {
    const interpretChatTurn = vi.fn(async () => ({
      route: "retrieval" as const,
      framing: { isIdentityQuestion: false },
      rewriteProposal: {
        rewrittenQuery: "refund timeline after returned item",
        semanticQuery: "refund timeline after returned item",
        lexicalQuery: "refund returned item timeline",
        constraints: [],
        responseLanguagePolicy: "match_user_question" as const,
        turnKind: "referential_followup" as const,
        relatedEntities: [],
        unresolved: false,
        confidence: 0.9,
      },
    }));
    const turnInterpreter: ChatConversationTurnInterpreter = { interpretChatTurn };
    const capturedRequests: RetrievalPipelineRequest[] = [];
    const runner = new WorkbenchReplayRunner({
      retrievalTurn: retrievalTurn(capturedRequests),
      auditService: createAuditService(),
      turnSkills: [answerSkill()],
      conversationEngine: new DefaultConversationEngine(),
      turnRouter: stubTurnRouter("direct"),
      turnInterpreter,
    });

    await runner.run({
      workspaceId: "ws-1",
      accountId: "acct-1",
      sourceAgentId: "agent-1",
      baselineAgentConfig: projectInternalAgentConfig(agent()),
      query: "How long will it take?",
      history: [],
      conversationSummary: "The buyer already returned the item last week.",
    });

    expect(interpretChatTurn).toHaveBeenCalledWith(expect.objectContaining({
      accountId: "acct-1",
      conversationSummary: "The buyer already returned the item last week.",
      query: "How long will it take?",
    }));
    expect(capturedRequests[0]?.precomputedRewriteProposal).toMatchObject({
      semanticQuery: "refund timeline after returned item",
      lexicalQuery: "refund returned item timeline",
    });
  });

  it("leaves the prepared session summary absent when the replay input carries none", async () => {
    const seen: { value?: string; called: boolean } = { called: false };
    const summarySkill: TurnSkill = {
      definition: { name: "replay.answer", outcomeKinds: ["replay"] },
      selects: () => true,
      dispatch: (session) => {
        seen.value = session.conversationSummary;
        seen.called = true;
        return {
          kind: "replay",
          skillName: "replay.answer",
          outcome: { status: "completed", answer: "ok" },
          stagedContext: session.stagedContext,
          steering: session.directiveSteering?.rules ?? [],
          trace: session.turnTrace,
        };
      },
      renderer: {
        supports: (outcome) => outcome.kind === "replay",
        render: async (outcome) => ({
          answer: outcome.outcome.answer ?? "",
          skillName: outcome.skillName,
          skillOutcome: outcome.outcome.status,
          skillStatus: outcome.outcome.status,
        }),
      },
    };
    const runner = new WorkbenchReplayRunner({
      retrievalTurn: retrievalTurn([]),
      auditService: createAuditService(),
      turnSkills: [summarySkill],
      conversationEngine: new DefaultConversationEngine(),
      turnRouter: stubTurnRouter(),
    });

    const result = await runner.run({
      workspaceId: "ws-1",
      sourceAgentId: "agent-1",
      baselineAgentConfig: projectInternalAgentConfig(agent()),
      query: "How long do refunds take?",
      history: [],
    });

    expect(seen.called).toBe(true);
    expect(seen.value).toBeUndefined();
    expect(result.resolvedConfig.conversationSummary).toBeUndefined();
  });

  it("executes the fused turn-planning schedule when the same coordinator + gate are wired", async () => {
    const capturedRequests: RetrievalPipelineRequest[] = [];
    const longHistory = Array.from({ length: 12 }, (_, index): MessageRecord => ({
      id: `history-${index}`,
      conversationId: "conv-1",
      workspaceId: "ws-1",
      role: index % 2 === 0 ? "user" : "assistant",
      content: `history-message-${index}`,
      createdAt: new Date(index),
    }));
    const classify = vi.fn(async () => ({ route: "retrieval" as const, framing: { isIdentityQuestion: false } }));
    const planText = JSON.stringify({
      route: "retrieval",
      isIdentityQuestion: false,
      intentTopic: null,
      inScopeRequest: null,
      outsideScopeRequest: null,
      rewrite: {
        rewrittenQuery: "refund processing duration",
        semanticQuery: "refund processing duration",
        lexicalQuery: "refund processing",
        queryShape: "policy_answer",
        temporalQueryMode: "none",
        retrievalSubqueries: [],
        turnKind: "fresh_subject",
        proposedActiveSubject: "refund processing",
        relatedEntities: [],
        unresolved: false,
        confidence: 0.95,
      },
      responseLanguage: "English",
      routineRankings: [],
      directiveClassifications: [{ name: "refund-tone", matched: true, confidence: 0.9 }],
    });
    const plannerComplete = vi.fn(async (_request: { prompt: string }) => ({ text: planText }));
    const throwingDirectiveGatewayFactory = {
      create: vi.fn(async () => {
        throw new Error("directive gateway must not be created on the fused fast path");
      }),
    };
    const runner = new WorkbenchReplayRunner({
      retrievalTurn: retrievalTurn(capturedRequests),
      auditService: createAuditService(),
      turnSkills: [answerSkill()],
      conversationEngine: new DefaultConversationEngine(),
      turnRouter: { classify },
      directiveSteering: createRouteScopedDirectiveSteering({
        capabilityPolicy: new DefaultAllowCapabilityPolicy(),
        registrations: [{
          directive: {
            name: "refund-tone",
            condition: { kind: "contextual", description: "when the customer asks about refunds" },
            action: "Use refund support tone.",
          },
        }],
        directiveMatchGatewayFactory: throwingDirectiveGatewayFactory,
      }),
      turnPlanCoordinator: new TurnPlanCoordinator(
        new TurnPlanService({ create: async () => ({ complete: plannerComplete }) }),
      ),
      turnPlanningGate: createTurnPlanningGate({ enabled: true }),
      turnPlanInterpretationContextSettings: {
        retrievalDefaultsProvider: { getDefaults: () => ({} as never) },
        skillSettingsResolver: {
          resolve: () => ({
            semanticRewriteInstructions: "Replay semantic guidance.",
            lexicalRewriteInstructions: "Replay lexical guidance.",
          } as never),
        },
      },
    });

    const result = await runner.run({
      workspaceId: "ws-1",
      sourceAgentId: "agent-1",
      baselineAgentConfig: projectInternalAgentConfig(agent()),
      query: "How long do refunds take?",
      history: longHistory,
      conversationSummary: "The buyer already returned the item last week.",
    });

    expect(result.answer).toBeTruthy();
    // The planner ran once; the staged router and directive gateway never did —
    // the identical fast-path schedule as live chat.
    expect(plannerComplete).toHaveBeenCalledTimes(1);
    expect(plannerComplete.mock.calls[0]?.[0].prompt).toContain("Replay semantic guidance.");
    expect(plannerComplete.mock.calls[0]?.[0].prompt).toContain("Replay lexical guidance.");
    expect(plannerComplete.mock.calls[0]?.[0].prompt).toContain("The buyer already returned the item last week.");
    expect(plannerComplete.mock.calls[0]?.[0].prompt).not.toContain("USER: history-message-0 [");
    expect(plannerComplete.mock.calls[0]?.[0].prompt).not.toContain("ASSISTANT: history-message-1 [");
    expect(plannerComplete.mock.calls[0]?.[0].prompt).toContain("history-message-11");
    expect(classify).not.toHaveBeenCalled();
    expect(throwingDirectiveGatewayFactory.create).not.toHaveBeenCalled();
    expect(capturedRequests[0]?.precomputedRewriteProposal?.rewrittenQuery).toBe("refund processing duration");
    expect(capturedRequests[0]?.responseLanguage).toBe("English");
    // The trace keeps the unchanged schedule shape.
    expect(result.turnTrace?.spine.stages.map((stage) => stage.kind)).toContain("turn_interpretation");
  });

  it("keeps the staged replay schedule when the planning gate is off", async () => {
    const classify = vi.fn(async () => ({ route: "retrieval" as const, framing: { isIdentityQuestion: false } }));
    const detect = vi.fn(async () => ({ responseLanguage: "Estonian" }));
    const plannerComplete = vi.fn(async () => ({ text: "unused" }));
    const capturedRequests: RetrievalPipelineRequest[] = [];
    const runner = new WorkbenchReplayRunner({
      retrievalTurn: retrievalTurn(capturedRequests),
      auditService: createAuditService(),
      turnSkills: [answerSkill()],
      conversationEngine: new DefaultConversationEngine(),
      turnRouter: { classify },
      responseLanguageDetector: { detect },
      turnPlanCoordinator: new TurnPlanCoordinator(
        new TurnPlanService({ create: async () => ({ complete: plannerComplete }) }),
      ),
      turnPlanningGate: createTurnPlanningGate({ enabled: false }),
    });

    await runner.run({
      workspaceId: "ws-1",
      sourceAgentId: "agent-1",
      baselineAgentConfig: projectInternalAgentConfig(agent()),
      query: "How long do refunds take?",
      history: [],
    });

    expect(plannerComplete).not.toHaveBeenCalled();
    expect(classify).toHaveBeenCalledTimes(1);
    expect(detect).toHaveBeenCalledTimes(1);
    expect(capturedRequests[0]?.responseLanguage).toBe("Estonian");
  });

  it("restores staged response-language detection when the planner output is malformed", async () => {
    const classify = vi.fn(async () => ({ route: "retrieval" as const, framing: { isIdentityQuestion: false } }));
    const detect = vi.fn(async () => ({ responseLanguage: "Spanish" }));
    const plannerComplete = vi.fn(async () => ({ text: "<<<not-json>>>" }));
    const capturedRequests: RetrievalPipelineRequest[] = [];
    const runner = new WorkbenchReplayRunner({
      retrievalTurn: retrievalTurn(capturedRequests),
      auditService: createAuditService(),
      turnSkills: [answerSkill()],
      conversationEngine: new DefaultConversationEngine(),
      turnRouter: { classify },
      responseLanguageDetector: { detect },
      turnPlanCoordinator: new TurnPlanCoordinator(
        new TurnPlanService({ create: async () => ({ complete: plannerComplete }) }),
      ),
      turnPlanningGate: createTurnPlanningGate({ enabled: true }),
    });

    await runner.run({
      workspaceId: "ws-1",
      sourceAgentId: "agent-1",
      baselineAgentConfig: projectInternalAgentConfig(agent()),
      query: "¿Cuánto tardan los reembolsos?",
      history: [],
    });

    expect(plannerComplete).toHaveBeenCalledTimes(1);
    expect(classify).toHaveBeenCalledTimes(1);
    expect(detect).toHaveBeenCalledTimes(1);
    expect(capturedRequests[0]?.responseLanguage).toBe("Spanish");
  });

  it("hydrates directive-bound agent skills so replay selects like live chat", async () => {
    const boundSkill: TurnSkill = {
      definition: { name: "order_lookup", outcomeKinds: ["agent_skill"] },
      selects: () => false,
      dispatch: (session) => ({
        kind: "agent_skill",
        skillName: "order_lookup",
        outcome: { status: "completed", answer: "Order 123 is in transit." },
        stagedContext: session.stagedContext,
        steering: session.directiveSteering?.rules ?? [],
        trace: session.turnTrace,
      }),
      renderer: {
        supports: (outcome) => outcome.kind === "agent_skill",
        render: async (outcome) => ({
          answer: outcome.outcome.answer ?? "",
          skillName: outcome.skillName,
          skillOutcome: outcome.outcome.status,
          skillStatus: outcome.outcome.status,
        }),
      },
    };
    const forSession = vi.fn(async () => ({
      turnSkills: [boundSkill],
      agenticRetrievalToolFactories: () => [],
      skillStates: new Map([["order_lookup", { enabled: true, turnCapable: true, stagingCapable: false }]]),
    }));
    const provider: AgentSkillTurnSkillProvider = { forSession };
    const boundAgent: ConversationAgent = {
      ...agent(),
      authoredDirectives: [{
        id: "directive-1",
        agentId: "agent-1",
        name: "order-status",
        condition: { kind: "always" },
        action: "Look up the order.",
        priority: null,
        binding: { kind: "skill", skillName: "order_lookup" },
        lifecycle: null,
        requiredCapabilities: [],
        dependsOn: [],
        excludes: [],
        routes: [],
        tags: [],
        description: null,
        metadata: {},
        createdAt: new Date(0),
        updatedAt: new Date(0),
      }],
    };
    const runner = new WorkbenchReplayRunner({
      retrievalTurn: retrievalTurn([]),
      auditService: createAuditService(),
      turnSkills: [answerSkill()],
      conversationEngine: new DefaultConversationEngine(),
      turnRouter: stubTurnRouter(),
      directiveSteering: createRouteScopedDirectiveSteering({
        capabilityPolicy: new DefaultAllowCapabilityPolicy(),
        registrations: [],
      }),
      agentSkillTurnSkillProvider: provider,
    });

    const result = await runner.run({
      workspaceId: "ws-1",
      sourceAgentId: "agent-1",
      baselineAgentConfig: projectInternalAgentConfig(boundAgent),
      query: "Where is order 123?",
      history: [],
    });

    expect(result.answer).toBe("Order 123 is in transit.");
    expect(forSession).toHaveBeenCalledOnce();
    const selection = result.turnTrace?.spine.stages.find((stage) => stage.kind === "skill_selection");
    expect(selection?.outputs ?? {}).toMatchObject({ reason: "directive:order-status" });
  });

  it("suppresses once_per_conversation directives that fired in replay history", async () => {
    const boundSkill: TurnSkill = {
      definition: { name: "order_lookup", outcomeKinds: ["agent_skill"] },
      selects: () => false,
      dispatch: (session) => ({
        kind: "agent_skill",
        skillName: "order_lookup",
        outcome: { status: "completed", answer: "Order 123 is in transit." },
        stagedContext: session.stagedContext,
        steering: session.directiveSteering?.rules ?? [],
        trace: session.turnTrace,
      }),
      renderer: {
        supports: (outcome) => outcome.kind === "agent_skill",
        render: async (outcome) => ({
          answer: outcome.outcome.answer ?? "",
          skillName: outcome.skillName,
          skillOutcome: outcome.outcome.status,
          skillStatus: outcome.outcome.status,
        }),
      },
    };
    const provider: AgentSkillTurnSkillProvider = {
      forSession: vi.fn(async () => ({
        turnSkills: [boundSkill],
        agenticRetrievalToolFactories: () => [],
        skillStates: new Map([["order_lookup", { enabled: true, turnCapable: true, stagingCapable: false }]]),
      })),
    };
    const boundAgent: ConversationAgent = {
      ...agent(),
      authoredDirectives: [{
        id: "directive-1",
        agentId: "agent-1",
        name: "order-status",
        condition: { kind: "always" },
        action: "Look up the order.",
        priority: null,
        binding: { kind: "skill", skillName: "order_lookup" },
        lifecycle: { kind: "once_per_conversation" },
        requiredCapabilities: [],
        dependsOn: [],
        excludes: [],
        routes: [],
        tags: [],
        description: null,
        metadata: {},
        createdAt: new Date(0),
        updatedAt: new Date(0),
      }],
    };
    const history: MessageRecord[] = [
      {
        id: "history-user",
        conversationId: "conv-1",
        workspaceId: "ws-1",
        role: "user",
        content: "Where is order 123?",
        createdAt: new Date(0),
      },
      {
        id: "history-assistant",
        conversationId: "conv-1",
        workspaceId: "ws-1",
        role: "assistant",
        content: "Order lookup happened.",
        metadata: { directiveFirings: ["order-status"] },
        createdAt: new Date(0),
      },
    ];
    const runner = new WorkbenchReplayRunner({
      retrievalTurn: retrievalTurn([]),
      auditService: createAuditService(),
      turnSkills: [answerSkill()],
      conversationEngine: new DefaultConversationEngine(),
      turnRouter: stubTurnRouter("direct"),
      directiveSteering: createRouteScopedDirectiveSteering({
        capabilityPolicy: new DefaultAllowCapabilityPolicy(),
        registrations: [],
      }),
      agentSkillTurnSkillProvider: provider,
    });

    const result = await runner.run({
      workspaceId: "ws-1",
      sourceAgentId: "agent-1",
      baselineAgentConfig: projectInternalAgentConfig(boundAgent),
      query: "Where is order 123 now?",
      history,
    });

    expect(result.answer).toBe("Answered with Answer from the operator baseline.");
    const selection = result.turnTrace?.spine.stages.find((stage) => stage.kind === "skill_selection");
    expect(selection?.outputs?.reason).not.toBe("directive:order-status");
  });

  it("stages directive-bound retrieval skills before replay grounding runs", async () => {
    const stagedFactory = vi.fn(() => []);
    const capturedRequests: RetrievalPipelineRequest[] = [];
    const forSession = vi.fn(async () => ({
      turnSkills: [],
      agenticRetrievalToolFactories: vi.fn(() => [stagedFactory]),
      skillStates: new Map([["grounded_search", { enabled: true, turnCapable: false, stagingCapable: true }]]),
    }));
    const provider: AgentSkillTurnSkillProvider = { forSession };
    const boundAgent: ConversationAgent = {
      ...agent(),
      authoredDirectives: [{
        id: "directive-1",
        agentId: "agent-1",
        name: "refund-lookup",
        condition: { kind: "always" },
        action: "Use the refund lookup skill.",
        priority: null,
        binding: { kind: "skill", skillName: "grounded_search" },
        lifecycle: null,
        requiredCapabilities: [],
        dependsOn: [],
        excludes: [],
        routes: [],
        tags: [],
        description: null,
        metadata: {},
        createdAt: new Date(0),
        updatedAt: new Date(0),
      }],
    };

    const runner = new WorkbenchReplayRunner({
      retrievalTurn: retrievalTurn(capturedRequests),
      auditService: createAuditService(),
      turnSkills: [answerSkill()],
      conversationEngine: new DefaultConversationEngine(),
      turnRouter: stubTurnRouter(),
      directiveSteering: createRouteScopedDirectiveSteering({
        capabilityPolicy: new DefaultAllowCapabilityPolicy(),
        registrations: [],
      }),
      agentSkillTurnSkillProvider: provider,
    });

    await runner.run({
      workspaceId: "ws-1",
      sourceAgentId: "agent-1",
      baselineAgentConfig: projectInternalAgentConfig(boundAgent),
      query: "How long do refunds take?",
      history: [],
    });

    expect(forSession).toHaveBeenCalledOnce();
    expect(capturedRequests[0]?.agenticToolFactories).toEqual([stagedFactory]);
  });

  it("does not wire routines or enqueue actions for contact-like replay queries", async () => {
    const engine = new DefaultConversationEngine();
    const attemptRoutine = vi.spyOn(engine, "attemptRoutine");
    const runner = new WorkbenchReplayRunner({
      retrievalTurn: retrievalTurn([]),
      auditService: createAuditService(),
      turnSkills: [answerSkill()],
      conversationEngine: engine,
      turnRouter: stubTurnRouter("retrieval"),
    });

    const result = await runner.run({
      workspaceId: "ws-1",
      sourceAgentId: "agent-1",
      baselineAgentConfig: projectInternalAgentConfig(agent()),
      query: "Please contact me at alex@example.com",
      history: [],
    });

    expect(result.answer).toContain("Answer from the operator baseline.");
    expect(attemptRoutine).toHaveBeenCalledOnce();
    expect(attemptRoutine.mock.calls[0]?.[0].routineStore).toBeUndefined();
    expect(attemptRoutine.mock.calls[0]?.[0].routineRunner).toBeUndefined();
    expect(attemptRoutine.mock.calls[0]?.[0].routineActivator).toBeUndefined();
    expect(result.turnTrace?.spine.stages.map((stage) => stage.kind)).not.toContain("routine_activate");
    expect(result.turnTrace?.spine.stages.map((stage) => stage.kind)).not.toContain("routine_resume");
  });

  it("returns the routine's reply and skips grounding when a routine claims the turn", async () => {
    const processTurn = vi.fn(async (): Promise<ProcessTurnResult> => {
      throw new Error("grounding must not run when a routine claims the turn");
    });
    const fakeEngine = {
      async attemptRoutine(): Promise<ProcessTurnResult | null> {
        return {
          response: { answer: "It seems you'd like follow-up — what's your email?" },
          trace: emptyTrace(),
          decision: { reason: "routine_activated:ask_email_on_interest" },
          actions: [],
        } as unknown as ProcessTurnResult;
      },
      processTurn,
    } as unknown as ConversationEngine;

    const runner = new WorkbenchReplayRunner({
      retrievalTurn: retrievalTurn([]),
      auditService: createAuditService(),
      turnSkills: [answerSkill()],
      conversationEngine: fakeEngine,
      turnRouter: stubTurnRouter("retrieval"),
      routineProvider: routineProviderStub(),
      chatGateway: chatGatewayStub(),
      chatAnswerPresenter: presenterStub(),
    });

    const result = await runner.run({
      workspaceId: "ws-1",
      sourceAgentId: "agent-1",
      baselineAgentConfig: projectInternalAgentConfig(agent()),
      query: "How does yearly billing save?",
      history: [],
    });

    expect(result.answer).toBe("It seems you'd like follow-up — what's your email?");
    expect(processTurn).not.toHaveBeenCalled();
  });

  it("provides an ephemeral clarification store and returns a routine clarification answer", async () => {
    const pending = {
      sessionId: "replaced-by-test",
      source: "routine_activation",
      candidates: [{
        id: "candidate-1",
        label: "Billing help",
        confidence: 0.5,
        payload: {},
      }],
      status: "pending" as const,
      expiresAt: new Date(Date.now() + 60_000),
    };
    const fakeEngine = {
      async attemptRoutine(input: AttemptRoutineInput): Promise<ProcessTurnResult | null> {
        expect(input.clarificationStore).toBeDefined();
        await input.clarificationStore!.save({ ...pending, sessionId: input.sessionId });
        expect(await input.clarificationStore!.loadPending({ sessionId: input.sessionId })).toBeNull();
        return {
          response: { answer: "Do you mean billing help or account help?" },
          trace: emptyTrace(),
          decision: { reason: "routine_clarification" },
          actions: [],
        } as unknown as ProcessTurnResult;
      },
      async processTurn(): Promise<ProcessTurnResult> {
        throw new Error("grounding must not run when clarification claims the turn");
      },
    } as unknown as ConversationEngine;

    const runner = new WorkbenchReplayRunner({
      retrievalTurn: retrievalTurn([]),
      auditService: createAuditService(),
      turnSkills: [answerSkill()],
      conversationEngine: fakeEngine,
      turnRouter: stubTurnRouter("retrieval"),
      routineProvider: routineProviderStub(),
      chatGateway: chatGatewayStub(),
      chatAnswerPresenter: presenterStub(),
      clarifier: {
        async phraseQuestion() {
          return "Do you mean billing help or account help?";
        },
        async mapReply() {
          return { kind: "unrelated" } as const;
        },
      },
    });

    const result = await runner.run({
      workspaceId: "ws-1",
      sourceAgentId: "agent-1",
      baselineAgentConfig: projectInternalAgentConfig(agent()),
      query: "I need help",
      history: [],
    });

    expect(result.answer).toBe("Do you mean billing help or account help?");
  });

  it("surfaces routine-declared actions, decisions, and handoff without dispatching them", async () => {
    const fakeEngine = {
      async attemptRoutine(input: AttemptRoutineInput): Promise<ProcessTurnResult | null> {
        await input.routineStore!.save({
          sessionId: input.sessionId,
          routineId: "contact",
          path: ["handoff", "approval"],
          variables: {},
          status: "suspended",
        });
        return {
          response: { answer: "A teammate will follow up." },
          trace: emptyTrace(),
          decision: { reason: "routine_completed" },
          actions: [{ type: "contact.send", payload: { email: "buyer@example.com" } }],
          handoff: { routineId: "contact", stepId: "handoff" },
          awaitingDecision: {
            stepId: "approval",
            captureKey: "approval_decision",
            options: [{ id: "approve", label: "Approve" }],
          },
        } as unknown as ProcessTurnResult;
      },
      async processTurn(): Promise<ProcessTurnResult> {
        throw new Error("grounding must not run when a routine claims the turn");
      },
    } as unknown as ConversationEngine;

    const runner = new WorkbenchReplayRunner({
      retrievalTurn: retrievalTurn([]),
      auditService: createAuditService(),
      turnSkills: [answerSkill()],
      conversationEngine: fakeEngine,
      turnRouter: stubTurnRouter("retrieval"),
      routineProvider: routineProviderStub(),
      chatGateway: chatGatewayStub(),
      chatAnswerPresenter: presenterStub(),
    });

    const result = await runner.run({
      workspaceId: "ws-1",
      sourceAgentId: "agent-1",
      baselineAgentConfig: projectInternalAgentConfig(agent()),
      query: "Please contact me",
      history: [],
    });

    expect(result.actions).toEqual(expect.arrayContaining([
      { type: "contact.send", payload: { email: "buyer@example.com" } },
      expect.objectContaining({ type: "approval.request" }),
    ]));
    expect(result.pendingDecisionTransition).toMatchObject({
      routineId: "contact",
      stepId: "approval",
      options: [{ id: "approve", label: "Approve" }],
    });
    expect(result.handoff).toEqual({ routineId: "contact", stepId: "handoff" });
  });

  it("seeds the in-memory routine store so the engine resumes mid-routine", async () => {
    let seen: AttemptRoutineInput | null = null;
    const fakeEngine = {
      async attemptRoutine(input: AttemptRoutineInput): Promise<ProcessTurnResult | null> {
        seen = input;
        const active = await input.routineStore!.loadActive({ sessionId: input.sessionId });
        return {
          response: { answer: `resumed:${active?.routineId}:${JSON.stringify(active?.variables ?? {})}` },
          trace: emptyTrace(),
          decision: { reason: "routine_resumed" },
          actions: [],
        } as unknown as ProcessTurnResult;
      },
      async processTurn(): Promise<ProcessTurnResult> {
        throw new Error("grounding must not run on resume");
      },
    } as unknown as ConversationEngine;

    const runner = new WorkbenchReplayRunner({
      retrievalTurn: retrievalTurn([]),
      auditService: createAuditService(),
      turnSkills: [answerSkill()],
      conversationEngine: fakeEngine,
      turnRouter: stubTurnRouter("retrieval"),
      routineProvider: routineProviderStub(),
      chatGateway: chatGatewayStub(),
      chatAnswerPresenter: presenterStub(),
    });

    const result = await runner.run({
      workspaceId: "ws-1",
      sourceAgentId: "agent-1",
      baselineAgentConfig: projectInternalAgentConfig(agent()),
      query: "Here's my email",
      history: [],
      routineStartState: {
        routineId: "ask_email_on_interest",
        path: ["step_1_ask"],
        variables: { customer_email: "buyer@example.com" },
        status: "active",
      },
    });

    expect(result.answer).toBe('resumed:ask_email_on_interest:{"customer_email":"buyer@example.com"}');
    // The store is keyed by the ephemeral conversation id the runner injects.
    expect(seen!.sessionId).toBeTruthy();
  });

  it("falls through to grounding when routine ports are wired but no routine claims the turn", async () => {
    const fakeEngine = {
      async attemptRoutine(): Promise<ProcessTurnResult | null> {
        return null;
      },
      async processTurn(input: ProcessTurnInput): Promise<ProcessTurnResult> {
        const outcome = await input.dispatcher.dispatch({ skill: { name: "replay.answer" } } as never);
        await input.composer.compose({ outcomes: [outcome] } as never);
        return { trace: emptyTrace(), decision: { reason: "answered" }, actions: [] } as unknown as ProcessTurnResult;
      },
    } as unknown as ConversationEngine;

    const runner = new WorkbenchReplayRunner({
      retrievalTurn: retrievalTurn([]),
      auditService: createAuditService(),
      turnSkills: [answerSkill()],
      conversationEngine: fakeEngine,
      turnRouter: stubTurnRouter("retrieval"),
      routineProvider: routineProviderStub(),
      chatGateway: chatGatewayStub(),
      chatAnswerPresenter: presenterStub(),
    });

    const result = await runner.run({
      workspaceId: "ws-1",
      sourceAgentId: "agent-1",
      baselineAgentConfig: projectInternalAgentConfig(agent()),
      query: "What is the refund policy?",
      history: [],
    });

    expect(result.answer).toContain("Answer from the operator baseline.");
  });
});
