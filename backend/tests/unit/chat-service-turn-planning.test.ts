import { describe, expect, it, vi } from "vitest";

import { createConversationEngine } from "@radioso/conversation-engine";
import { RoutineRegistry, type RoutineRegistration } from "@radioso/conversation-defaults";

import {
  ChatService,
  ModelChatGateway,
  type ChatServiceOptions,
  type ChatStreamEvent,
} from "../../src/modules/chat/services/chatService.js";
import {
  buildChatTurnRuntime,
} from "../../src/modules/chat/services/chatTurnRuntime.js";
import { RetrievalTurnController } from "../../src/modules/chat/services/retrievalTurnDispatch.js";
import { createRouteScopedDirectiveSteering } from "../../src/modules/chat/services/routeScopedDirectiveSteering.js";
import {
  TurnPlanCoordinator,
  planAwareRoutineActivator,
  planAwareRoutineReentryGate,
  planAwareRoutineSlotCorrection,
} from "../../src/modules/chat/services/turnPlanCoordinator.js";
import {
  TurnPlanService,
  type TurnPlanGatewayFactory,
} from "../../src/modules/chat/services/turnPlanService.js";
import { DefaultAllowCapabilityPolicy } from "../../src/shared/domain/capabilityPolicy.js";
import { ModelInferencePipelineService } from "../../src/shared/infra/llm/modelInferencePipeline.js";
import type { FallbackReplyComposer } from "../../src/modules/chat/services/fallbackReplyComposer.js";
import type { ModelUsageEvent, UsageEventRecorder } from "../../src/shared/domain/usageEventRecorder.js";
import {
  createAuditService,
  InMemoryConversationRepository,
  InMemoryMessageRepository,
} from "../support/fakes.js";

const fallbackReplyComposer: FallbackReplyComposer = {
  async composeNoContext() {
    return "No supporting material found.";
  },
};

/** A valid planner completion (JSON-in-text) for the given route. */
const planJson = (input: {
  route: "direct" | "retrieval";
  responseLanguage?: string;
  routineRankings?: Array<{ routineId: string; confidence: number; variables?: Record<string, unknown> }>;
  directiveClassifications?: Array<{ name: string; matched: boolean; confidence: number }>;
}): string =>
  JSON.stringify({
    route: input.route,
    isIdentityQuestion: false,
    intentTopic: null,
    inScopeRequest: null,
    outsideScopeRequest: null,
    rewrite: input.route === "retrieval"
      ? {
          rewrittenQuery: "planned rewritten query",
          semanticQuery: "planned semantic query",
          lexicalQuery: "planned lexical query",
          queryShape: "general_grounding",
          temporalQueryMode: "none",
          retrievalSubqueries: [],
          turnKind: "fresh_subject",
          proposedActiveSubject: null,
          relatedEntities: [],
          unresolved: false,
          confidence: 0.9,
        }
      : null,
    responseLanguage: input.responseLanguage ?? "English",
    // The planner wire format carries slot values as field/value pairs, not a
    // free-form object (strict provider schema). Convert the fixture's record here.
    routineRankings: (input.routineRankings ?? []).map((ranking) => ({
      routineId: ranking.routineId,
      confidence: ranking.confidence,
      ...(ranking.variables
        ? {
            variables: Object.entries(ranking.variables).map(([field, value]) => ({
              field,
              value: String(value),
            })),
          }
        : {}),
    })),
    directiveClassifications: input.directiveClassifications ?? [],
  });

const capturingUsageRecorder = (): UsageEventRecorder & { events: ModelUsageEvent[] } => {
  const events: ModelUsageEvent[] = [];
  return {
    events,
    async recordModelCall(event) {
      events.push(event);
    },
  } as UsageEventRecorder & { events: ModelUsageEvent[] };
};

/** Planner factory over a real inference pipeline so trace + usage record. */
const plannerFactory = (input: {
  completions: string[];
  recorder?: UsageEventRecorder;
  neverComplete?: boolean;
}): TurnPlanGatewayFactory & { completeCalls: () => number; prompts: () => string[] } => {
  const prompts: string[] = [];
  const complete = vi.fn(async (request: { prompt: string; signal?: AbortSignal }) => {
    prompts.push(request.prompt);
    if (input.neverComplete) {
      return new Promise<never>((_resolve, reject) => {
        if (request.signal?.aborted) {
          reject(new Error("aborted"));
          return;
        }
        request.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }
    const text = input.completions.shift() ?? input.completions[0] ?? "";
    return { text, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, quality: "actual" as const } };
  });
  const inference = new ModelInferencePipelineService(
    {
      metadata: { capability: "chat", provider: "openai", model: "gpt-planner" },
      complete: complete as never,
      stream: vi.fn(),
    },
    input.recorder,
  );
  return {
    completeCalls: () => complete.mock.calls.length,
    prompts: () => prompts,
    async create(createInput) {
      return {
        complete: (request) => inference.complete({ ...request, operation: createInput.usageContext }),
      };
    },
  };
};

/** Chat gateway over a real inference pipeline so the answer call is traced. */
const pipelineChatGateway = (answerText: string, recorder?: UsageEventRecorder) =>
  new ModelChatGateway(
    new ModelInferencePipelineService(
      {
        metadata: { capability: "chat", provider: "openai", model: "gpt-answer" },
        complete: vi.fn(async () => ({
          text: answerText,
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, quality: "actual" as const },
        })),
        stream: vi.fn(() => ({
          textStream: (async function* () {
            yield answerText;
          })(),
          usage: Promise.resolve({ inputTokens: 10, outputTokens: 5, totalTokens: 15, quality: "actual" as const }),
        })),
      },
      recorder,
    ),
  );

const directPipeline = (query: string) => ({
  async interpret(request: unknown) {
    return {
      request,
      traceStartedAtMs: Date.now(),
      context: { result: {} as never, startedAt: Date.now(), durationMs: 0 },
      interpretation: { startedAt: Date.now(), durationMs: 0 },
    };
  },
  async runInterpreted() {
    throw new Error("runInterpreted should not run for a direct turn");
  },
  async runWithoutRetrieval() {
    return {
      rewrittenQuery: query,
      contexts: [],
      prompt: "",
      citations: [],
      responseIdentity: null,
      responseSettings: {
        citationDisplayEnabled: true,
        suggestedQuestionsEnabled: false,
        suggestedQuestionsCount: 0,
        customInstruction: "",
        responseLanguagePolicy: "match_user_question",
      },
      diagnostics: {
        rewriteStatus: "skipped",
        rerankStatus: "skipped",
        originalCandidateCount: 0,
        rewrittenCandidateCount: 0,
        lexicalCandidateCount: 0,
        normalizedCandidateCount: 0,
        finalContextCount: 0,
        candidateFallbackApplied: false,
        fallbackApplied: false,
        retrievalSkipped: true,
      },
      trace: { startedAt: new Date().toISOString(), stages: [], links: [] },
    };
  },
});

const retrievalPipeline = (captured: unknown[]) => ({
  async interpret(request: unknown) {
    captured.push(request);
    return {
      request,
      traceStartedAtMs: Date.now(),
      context: { result: {} as never, startedAt: Date.now(), durationMs: 0 },
      interpretation: { startedAt: Date.now(), durationMs: 0 },
    };
  },
  async runInterpreted(interpreted: { request: { query: string } }) {
    return {
      rewrittenQuery: interpreted.request.query,
      contexts: [],
      prompt: "prompt text",
      citations: [],
      diagnostics: {
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
      responseSettings: { citationDisplayEnabled: true },
    };
  },
  async runWithoutRetrieval() {
    throw new Error("runWithoutRetrieval should not run for a retrieval turn");
  },
});

const countingStagedPorts = () => {
  const routerClassify = vi.fn(async () => ({ route: "retrieval" as const, framing: { isIdentityQuestion: false } }));
  const languageDetect = vi.fn(async () => ({ responseLanguage: "Estonian" }));
  return {
    routerClassify,
    languageDetect,
    turnRouter: { classify: routerClassify },
    responseLanguageDetector: { detect: languageDetect },
  };
};

const noPendingClarification = () => ({
  clarifier: {
    phraseQuestion: vi.fn(async () => "Which one?"),
    mapReply: vi.fn(async () => ({ kind: "unrelated" as const })),
  },
  clarificationStore: {
    loadPending: vi.fn(async () => null),
    save: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
  },
});

const buildService = (input: {
  planner?: TurnPlanGatewayFactory;
  pipeline: Record<string, unknown>;
  chatGateway: ChatServiceOptions["chatGateway"];
  staged: ReturnType<typeof countingStagedPorts>;
  directiveSteering?: ChatServiceOptions["directiveSteering"];
  routine?: {
    routineStore: ChatServiceOptions["routineStore"];
    routineProvider: ChatServiceOptions["routineProvider"];
  };
  conversationSummary?: string;
  turnPlanInterpretationContextSettings?: ChatServiceOptions["turnPlanInterpretationContextSettings"];
  clarification?: {
    clarifier: NonNullable<ChatServiceOptions["clarifier"]>;
    clarificationStore: NonNullable<ChatServiceOptions["clarificationStore"]>;
  };
}): ChatService =>
  new ChatService({
    conversationRepository: new InMemoryConversationRepository(),
    messageRepository: new InMemoryMessageRepository(),
    retrievalTurn: new RetrievalTurnController(input.pipeline as never),
    chatGateway: input.chatGateway,
    auditService: createAuditService(),
    turnRuntime: buildChatTurnRuntime({
      chatGateway: input.chatGateway,
      fallbackReplyComposer,
      skillOutcomeCapabilities: { supportsGroundedAnswer: () => true },
    }),
    turnRouter: input.staged.turnRouter,
    responseLanguageDetector: input.staged.responseLanguageDetector,
    directiveSteering: input.directiveSteering,
    conversationEngine: createConversationEngine(),
    routineStore: input.routine?.routineStore,
    routineProvider: input.routine?.routineProvider,
    clarifier: input.clarification?.clarifier,
    clarificationStore: input.clarification?.clarificationStore,
    conversationSummaryStore: input.conversationSummary
      ? {
          load: vi.fn(async () => ({
            summary: input.conversationSummary!,
            coveredMessageCount: 10,
            coveredThrough: new Date("2026-01-01T00:00:00.000Z"),
          })),
        }
      : undefined,
    turnPlanInterpretationContextSettings: input.turnPlanInterpretationContextSettings,
    ...(input.planner
      ? {
          turnPlanCoordinator: new TurnPlanCoordinator(new TurnPlanService(input.planner)),
        }
      : {}),
  });

describe("chat service fused turn planning", () => {
  it("plans a fresh turn when clarification support is wired but nothing is pending", async () => {
    const staged = countingStagedPorts();
    const planner = plannerFactory({ completions: [planJson({ route: "direct" })] });
    const service = buildService({
      planner,
      pipeline: directPipeline("thanks!"),
      chatGateway: pipelineChatGateway("You're welcome!"),
      staged,
      clarification: noPendingClarification(),
    });

    await service.answer({ workspaceId: "workspace-1", query: "thanks!", stream: false });

    expect(planner.completeCalls()).toBe(1);
    expect(staged.routerClassify).not.toHaveBeenCalled();
    expect(staged.languageDetect).not.toHaveBeenCalled();
  });

  it("plans a fresh streaming turn when clarification support is wired but nothing is pending", async () => {
    const staged = countingStagedPorts();
    const planner = plannerFactory({ completions: [planJson({ route: "direct" })] });
    const service = buildService({
      planner,
      pipeline: directPipeline("thanks!"),
      chatGateway: pipelineChatGateway("You're welcome!"),
      staged,
      clarification: noPendingClarification(),
    });

    for await (const _event of service.streamAnswer({
      workspaceId: "workspace-1",
      query: "thanks!",
      stream: true,
    })) {
      // Drain the stream so the turn completes and its trace is finalized.
    }

    expect(planner.completeCalls()).toBe(1);
    expect(staged.routerClassify).not.toHaveBeenCalled();
    expect(staged.languageDetect).not.toHaveBeenCalled();
  });

  it("answers a planned direct turn with exactly two model calls (plan + answer)", async () => {
    const recorder = capturingUsageRecorder();
    const staged = countingStagedPorts();
    const planner = plannerFactory({ completions: [planJson({ route: "direct" })], recorder });
    const service = buildService({
      planner,
      pipeline: directPipeline("thanks!"),
      chatGateway: pipelineChatGateway("You're welcome!", recorder),
      staged,
    });

    const response = await service.answer({ workspaceId: "workspace-1", query: "thanks!", stream: false });

    expect(response.answer).toContain("You're welcome!");
    expect(planner.completeCalls()).toBe(1);
    // Exactly two model calls on the turn: the fused plan and the answer.
    expect(response.turnTrace?.summary).toMatchObject({ totalLlmCalls: 2 });
    const modelCalls = response.turnTrace?.spine.stages.find((stage) => stage.kind === "model_calls")
      ?.outputs?.modelCalls as Array<{ operation: string; stageId: string }>;
    expect(modelCalls.map((call) => call.operation).sort()).toEqual(["answer", "turn_planning"]);
    expect(modelCalls.find((call) => call.operation === "turn_planning")).toMatchObject({ stageId: "pre_engine" });
    // No staged classification call ran.
    expect(staged.routerClassify).not.toHaveBeenCalled();
    expect(staged.languageDetect).not.toHaveBeenCalled();
    // The planner call is usage-accounted under its own operation and attempt key.
    const planningUsage = recorder.events.filter((event) => event.operation === "turn_planning");
    expect(planningUsage).toHaveLength(1);
    expect(planningUsage[0]).toMatchObject({ status: "succeeded", surface: "assistant" });
  });

  it("streams a planned direct turn with exactly two model calls", async () => {
    const staged = countingStagedPorts();
    const planner = plannerFactory({ completions: [planJson({ route: "direct" })] });
    const service = buildService({
      planner,
      pipeline: directPipeline("thanks!"),
      chatGateway: pipelineChatGateway("You're welcome!"),
      staged,
    });

    const events: ChatStreamEvent[] = [];
    for await (const event of service.streamAnswer({ workspaceId: "workspace-1", query: "thanks!", stream: true })) {
      events.push(event);
    }

    expect(events.some((event) => event.type === "chunk")).toBe(true);
    expect(planner.completeCalls()).toBe(1);
    expect(staged.routerClassify).not.toHaveBeenCalled();
    expect(staged.languageDetect).not.toHaveBeenCalled();
  });

  it("runs a planned retrieval turn with zero staged classification calls and the plan's rewrite", async () => {
    const staged = countingStagedPorts();
    const captured: Array<{ precomputedRewriteProposal?: { rewrittenQuery?: string } }> = [];
    const planner = plannerFactory({ completions: [planJson({ route: "retrieval" })] });
    const service = buildService({
      planner,
      pipeline: retrievalPipeline(captured),
      chatGateway: pipelineChatGateway("Grounded [[1]]."),
      staged,
    });

    const response = await service.answer({ workspaceId: "workspace-1", query: "refund window?", stream: false });

    expect(response.answer).toBeTruthy();
    expect(planner.completeCalls()).toBe(1);
    expect(staged.routerClassify).not.toHaveBeenCalled();
    expect(staged.languageDetect).not.toHaveBeenCalled();
    // The plan's structured rewrite reaches retrieval as the precomputed proposal,
    // exactly as the staged interpreter's proposal does.
    expect(captured[0]?.precomputedRewriteProposal).toMatchObject({ rewrittenQuery: "planned rewritten query" });
  });

  it("passes the agent's resolved semantic and lexical rewrite instructions to the planner", async () => {
    const staged = countingStagedPorts();
    const planner = plannerFactory({ completions: [planJson({ route: "retrieval" })] });
    const resolve = vi.fn(() => ({
      semanticRewriteInstructions: "Keep product concepts semantically distinct.",
      lexicalRewriteInstructions: "Preserve exact contract identifiers.",
    }));
    const service = buildService({
      planner,
      pipeline: retrievalPipeline([]),
      chatGateway: pipelineChatGateway("Grounded [[1]]."),
      staged,
      turnPlanInterpretationContextSettings: {
        retrievalDefaultsProvider: { getDefaults: vi.fn(() => ({} as never)) },
        skillSettingsResolver: { resolve: resolve as never },
      },
    });

    await service.answer({ workspaceId: "workspace-1", query: "refund window?", stream: false });

    expect(resolve).toHaveBeenCalledWith("retrieval.answer", {}, undefined);
    expect(planner.prompts()[0]).toContain("Keep product concepts semantically distinct.");
    expect(planner.prompts()[0]).toContain("Preserve exact contract identifiers.");
  });

  it("passes the prepared conversation summary to the live planner", async () => {
    const staged = countingStagedPorts();
    const planner = plannerFactory({ completions: [
      planJson({ route: "retrieval" }),
      planJson({ route: "retrieval" }),
    ] });
    const service = buildService({
      planner,
      pipeline: retrievalPipeline([]),
      chatGateway: pipelineChatGateway("Grounded [[1]]."),
      staged,
      conversationSummary: "The buyer already returned the item last week.",
    });

    const first = await service.answer({ workspaceId: "workspace-1", query: "I returned the item.", stream: false });
    await service.answer({
      workspaceId: "workspace-1",
      conversationId: first.conversationId,
      query: "What happens next?",
      stream: false,
    });

    expect(planner.prompts()[1]).toContain("The buyer already returned the item last week.");
  });

  it("falls back to the full staged path when the planner returns malformed output", async () => {
    const staged = countingStagedPorts();
    const planner = plannerFactory({ completions: ["<<<not json>>>"] });
    const service = buildService({
      planner,
      pipeline: retrievalPipeline([]),
      chatGateway: pipelineChatGateway("Grounded [[1]]."),
      staged,
    });

    const response = await service.answer({ workspaceId: "workspace-1", query: "refund window?", stream: false });

    expect(response.answer).toBeTruthy();
    expect(planner.completeCalls()).toBe(1);
    // All-or-nothing: every staged classification call is restored.
    expect(staged.routerClassify).toHaveBeenCalledTimes(1);
    expect(staged.languageDetect).toHaveBeenCalledTimes(1);
  });

  it("rejects the whole plan on an unknown directive name and falls back staged", async () => {
    const staged = countingStagedPorts();
    const planner = plannerFactory({
      completions: [
        planJson({
          route: "retrieval",
          directiveClassifications: [{ name: "not-a-candidate", matched: true, confidence: 0.9 }],
        }),
      ],
    });
    const service = buildService({
      planner,
      pipeline: retrievalPipeline([]),
      chatGateway: pipelineChatGateway("Grounded [[1]]."),
      staged,
    });

    await service.answer({ workspaceId: "workspace-1", query: "refund window?", stream: false });

    expect(planner.completeCalls()).toBe(1);
    expect(staged.routerClassify).toHaveBeenCalledTimes(1);
    expect(staged.languageDetect).toHaveBeenCalledTimes(1);
  });

  it("falls back staged when the planner times out, without an unhandled rejection", async () => {
    const staged = countingStagedPorts();
    const planner = plannerFactory({ completions: [], neverComplete: true });
    const service = new ChatService({
      conversationRepository: new InMemoryConversationRepository(),
      messageRepository: new InMemoryMessageRepository(),
      retrievalTurn: new RetrievalTurnController(retrievalPipeline([]) as never),
      chatGateway: pipelineChatGateway("Grounded [[1]]."),
      auditService: createAuditService(),
      turnRuntime: buildChatTurnRuntime({
        chatGateway: pipelineChatGateway("Grounded [[1]]."),
        fallbackReplyComposer,
        skillOutcomeCapabilities: { supportsGroundedAnswer: () => true },
      }),
      turnRouter: staged.turnRouter,
      responseLanguageDetector: staged.responseLanguageDetector,
      conversationEngine: createConversationEngine(),
      turnPlanCoordinator: new TurnPlanCoordinator(
        new TurnPlanService(planner, { timeoutMs: 10 }),
      ),
    });

    const response = await service.answer({ workspaceId: "workspace-1", query: "refund window?", stream: false });

    expect(response.answer).toBeTruthy();
    expect(planner.completeCalls()).toBe(1);
    expect(staged.routerClassify).toHaveBeenCalledTimes(1);
    expect(staged.languageDetect).toHaveBeenCalledTimes(1);
  });

  it("never invokes the planner while a routine is active for the conversation", async () => {
    const staged = countingStagedPorts();
    const planner = plannerFactory({ completions: [planJson({ route: "direct" })] });
    const routineStore: NonNullable<ChatServiceOptions["routineStore"]> = {
      loadActive: async () => ({
        sessionId: "s",
        routineId: "contact.request",
        path: ["ask_email"],
        variables: {},
        status: "active",
      }),
      save: async () => {},
      clear: async () => {},
    };
    const routineProvider: NonNullable<ChatServiceOptions["routineProvider"]> = {
      forTurn: async () => ({
        activator: { activate: async () => null },
        runner: {
          resume: async () => ({
            response: { answer: "What is your email?" },
            nextState: { sessionId: "s", routineId: "contact.request", path: ["ask_email"], variables: {}, status: "active" },
          }),
        },
      }),
    };
    const service = buildService({
      planner,
      pipeline: directPipeline("my email is a@b.c"),
      chatGateway: pipelineChatGateway("unused"),
      staged,
      routine: { routineStore, routineProvider },
    });

    const response = await service.answer({ workspaceId: "workspace-1", query: "my email is a@b.c", stream: false });

    expect(response.answer).toContain("What is your email?");
    expect(planner.completeCalls()).toBe(0);
  });

  it("resolves contextual directives from the plan with zero directive-match gateway calls, and restores the gateway on fallback", async () => {
    const gatewayFactory = {
      create: vi.fn(async () => ({
        match: vi.fn(async () => [{ name: "refund-tone", confidence: 0.9 }]),
      })),
    };
    const steering = () =>
      createRouteScopedDirectiveSteering({
        capabilityPolicy: new DefaultAllowCapabilityPolicy(),
        registrations: [
          {
            directive: {
              name: "refund-tone",
              condition: { kind: "contextual", description: "when the customer asks about refunds" },
              action: "Use refund support tone.",
            },
          },
        ],
        directiveMatchGatewayFactory: gatewayFactory,
      });

    // Fast path: plan classifies the directive; the gateway factory is never used.
    const stagedFast = countingStagedPorts();
    const fastPlanner = plannerFactory({
      completions: [
        planJson({
          route: "retrieval",
          directiveClassifications: [{ name: "refund-tone", matched: true, confidence: 0.85 }],
        }),
      ],
    });
    const fastService = buildService({
      planner: fastPlanner,
      pipeline: retrievalPipeline([]),
      chatGateway: pipelineChatGateway("Grounded [[1]]."),
      staged: stagedFast,
      directiveSteering: steering(),
    });
    await fastService.answer({ workspaceId: "workspace-1", query: "can I get a refund?", stream: false });
    expect(fastPlanner.completeCalls()).toBe(1);
    expect(gatewayFactory.create).not.toHaveBeenCalled();

    // Fallback: malformed plan restores the staged directive-match gateway call.
    const stagedFallback = countingStagedPorts();
    const failingPlanner = plannerFactory({ completions: ["garbage"] });
    const fallbackService = buildService({
      planner: failingPlanner,
      pipeline: retrievalPipeline([]),
      chatGateway: pipelineChatGateway("Grounded [[1]]."),
      staged: stagedFallback,
      directiveSteering: steering(),
    });
    await fallbackService.answer({ workspaceId: "workspace-1", query: "can I get a refund?", stream: false });
    expect(gatewayFactory.create).toHaveBeenCalledTimes(1);
  });

  it("activates a routine from precomputed rankings with zero ranked-activation gateway calls", async () => {
    const staged = countingStagedPorts();
    const registration: RoutineRegistration = {
      routine: { id: "contact.request", rootStepId: "ask_email", steps: [], transitions: [] },
      trigger: { description: "User wants to contact the team", priority: 0 },
    };
    const registry = new RoutineRegistry([registration], {
      policy: { floor: 0.4, margin: 0.15, maxOptions: 4 },
    });
    const rankedActivationGateway = { complete: vi.fn(async () => ({ text: "{\"matches\":[]}" })) };
    const planner = plannerFactory({
      completions: [
        planJson({
          route: "direct",
          routineRankings: [{
            routineId: "contact.request",
            confidence: 0.95,
            variables: { company: "Acme", preferredDay: "tomorrow" },
          }],
        }),
      ],
    });
    const routineStore: NonNullable<ChatServiceOptions["routineStore"]> = {
      loadActive: async () => null,
      save: async () => {},
      clear: async () => {},
    };
    // Production-shaped provider wiring: the plan-aware activator over the real
    // registry seams, staged ranked activation as fallback (dependencyBuilders).
    const resume = vi.fn(async (input: { state: { variables: Record<string, unknown> } }) => ({
      response: { answer: "What is your email?" },
      nextState: {
        sessionId: "s",
        routineId: "contact.request",
        path: ["ask_email"],
        variables: input.state.variables,
        status: "active" as const,
      },
    }));
    const routineProvider: NonNullable<ChatServiceOptions["routineProvider"]> = {
      forTurn: async ({ turnPlan }) => ({
        activator: planAwareRoutineActivator({
          handle: turnPlan,
          registry,
          fallback: registry.activator(rankedActivationGateway),
        }),
        runner: { resume: resume as never },
      }),
    };
    const service = buildService({
      planner,
      pipeline: directPipeline("I want to talk to someone"),
      chatGateway: pipelineChatGateway("unused"),
      staged,
      routine: { routineStore, routineProvider },
    });

    const response = await service.answer({
      workspaceId: "workspace-1",
      query: "I want to talk to someone",
      stream: false,
    });

    expect(response.answer).toContain("What is your email?");
    // One planner call ranked the routine; the staged ranked-activation gateway
    // never ran.
    expect(planner.completeCalls()).toBe(1);
    expect(rankedActivationGateway.complete).not.toHaveBeenCalled();
    expect(staged.languageDetect).not.toHaveBeenCalled();
    expect(resume).toHaveBeenCalledWith(expect.objectContaining({
      state: expect.objectContaining({
        variables: { company: "Acme", preferredDay: "tomorrow" },
      }),
    }));
  });

  it("bypasses planning on a non-streamed completed-routine slot correction", async () => {
    const staged = countingStagedPorts();
    const planner = plannerFactory({ completions: [planJson({ route: "direct" })] });
    const save = vi.fn(async () => {});
    const routineStore: NonNullable<ChatServiceOptions["routineStore"]> = {
      loadActive: async () => null,
      loadCompleted: async () => [{
        sessionId: "s",
        routineId: "contact.request",
        path: ["done"],
        variables: { email: "old@example.com" },
        status: "completed",
      }],
      save,
      clear: async () => {},
    };
    const routineProvider: NonNullable<ChatServiceOptions["routineProvider"]> = {
      forTurn: async ({ turnPlan }) => ({
        activator: { activate: vi.fn(async () => null) },
        runner: { resume: vi.fn() as never },
        slotCorrection: planAwareRoutineSlotCorrection({
          handle: turnPlan,
          fallback: {
            detect: vi.fn(async () => ({
              slots: [{ id: "email", key: "email", type: "email" as const, required: true, mutable: true }],
              slotKey: "email",
              rawValue: "new@example.com",
            })),
            confirm: vi.fn(async () => "Done — I updated your email."),
            rejectInvalid: vi.fn(async () => "Please provide a valid email."),
          },
        }),
      }),
    };
    const service = buildService({
      planner,
      pipeline: directPipeline("actually use new@example.com"),
      chatGateway: pipelineChatGateway("unused"),
      staged,
      routine: { routineStore, routineProvider },
    });

    const response = await service.answer({
      workspaceId: "workspace-1",
      query: "actually use new@example.com",
      stream: false,
    });

    expect(response.answer).toContain("updated your email");
    expect(planner.completeCalls()).toBe(0);
    expect(staged.languageDetect).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(expect.objectContaining({
      variables: { email: "new@example.com" },
      status: "completed",
    }));
  });

  it("bypasses planning on a streamed completed-routine semantic reentry", async () => {
    const staged = countingStagedPorts();
    const planner = plannerFactory({ completions: [planJson({ route: "direct" })] });
    const resume = vi.fn(async () => ({ response: { answer: "Let's continue." }, nextState: null }));
    const routineStore: NonNullable<ChatServiceOptions["routineStore"]> = {
      loadActive: async () => null,
      loadCompleted: async () => [{
        sessionId: "s",
        routineId: "contact.request",
        path: ["done"],
        variables: { company: "Acme" },
        status: "completed",
      }],
      save: async () => {},
      clear: async () => {},
    };
    const routineProvider: NonNullable<ChatServiceOptions["routineProvider"]> = {
      forTurn: async ({ turnPlan }) => ({
        activator: { activate: vi.fn(async () => null) },
        runner: { resume },
        reentryGate: planAwareRoutineReentryGate({
          handle: turnPlan,
          fallback: { decide: vi.fn(async () => ({ kind: "resume_existing" as const })) },
        }),
      }),
    };
    const service = buildService({
      planner,
      pipeline: directPipeline("let's do that again"),
      chatGateway: pipelineChatGateway("unused"),
      staged,
      routine: { routineStore, routineProvider },
    });

    const events: ChatStreamEvent[] = [];
    for await (const event of service.streamAnswer({
      workspaceId: "workspace-1",
      query: "let's do that again",
      stream: true,
    })) {
      events.push(event);
    }

    expect(events.some((event) => event.type === "done")).toBe(true);
    expect(planner.completeCalls()).toBe(0);
    expect(staged.languageDetect).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledWith(expect.objectContaining({
      state: expect.objectContaining({ variables: { company: "Acme" }, status: "active" }),
    }));
  });

  it("forwards the request's previewRoutineIds to the routine provider (workbench draft test)", async () => {
    const staged = countingStagedPorts();
    const planner = plannerFactory({ completions: [planJson({ route: "direct" })] });
    const routineStore: NonNullable<ChatServiceOptions["routineStore"]> = {
      loadActive: async () => null,
      loadCompleted: async () => [],
      save: async () => {},
      clear: async () => {},
    };
    let receivedPreviewRoutineIds: string[] | undefined;
    const routineProvider: NonNullable<ChatServiceOptions["routineProvider"]> = {
      forTurn: async ({ previewRoutineIds }) => {
        receivedPreviewRoutineIds = previewRoutineIds;
        // No activation — the draft under test does not claim this turn, so the
        // request falls through to a normal direct answer.
        return { activator: { activate: async () => null }, runner: { resume: vi.fn() as never } };
      },
    };
    const service = buildService({
      planner,
      pipeline: directPipeline("hello"),
      chatGateway: pipelineChatGateway("Hi there!"),
      staged,
      routine: { routineStore, routineProvider },
    });

    const draftRoutineId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const response = await service.answer({
      workspaceId: "workspace-1",
      query: "hello",
      stream: false,
      previewRoutineIds: [draftRoutineId],
    });

    expect(response.answer).toContain("Hi there!");
    expect(receivedPreviewRoutineIds).toEqual([draftRoutineId]);
  });
});
