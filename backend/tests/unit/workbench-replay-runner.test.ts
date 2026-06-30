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
import type { TurnRouter } from "../../src/modules/chat/services/turnRouter.js";
import type { RetrievalTurnPort } from "../../src/modules/chat/services/retrievalTurnDispatch.js";
import type { TurnSkill } from "../../src/modules/chat/services/turnOutcome.js";
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
      metadata: {},
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
    });

    expect(result.answer).toBe("Answered with Replay override.");
    expect(result.citations).toEqual([{ documentId: "doc-1", chunkId: "chunk-1", title: "Refund Policy" }]);
    expect(result.turnTrace?.spine.stages.map((stage) => stage.kind)).toEqual([
      "message",
      "gather",
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
      }],
    });
    expect(capturedRequests[0]?.history).toEqual([]);
    expect(classify).toHaveBeenCalledOnce();
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
