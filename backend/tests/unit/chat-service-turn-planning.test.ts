import { describe, expect, it, vi } from "vitest";

import { createConversationEngine } from "@radioso/conversation-engine";
import { RoutineRegistry, type RoutineRegistration } from "@radioso/conversation-defaults";
import type { ConversationRoutineRunner, Routine, StagedContext } from "@radioso/conversation-contract";
import type { AgentRecord } from "../../src/modules/agents/domain.js";
import type { LlmCapabilityResolveInput } from "../../src/shared/infra/llm/workspaceContext.js";
import type { AgentRevision } from "../../src/modules/agents/agentRevision.js";
import { AgentRevisionRuntimeResolver } from "../../src/modules/agents/runtime/agentRevisionRuntimeResolver.js";

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
import type { ChatGateway } from "../../src/modules/chat/contracts/chatGateway.js";
import { SKILL_TURN_OUTCOME } from "../../src/modules/chat/services/assistantTurnOutcomeTypes.js";
import { HANDOFF_NOTIFY_ACTION_TYPE } from "../../src/modules/chat/services/routines/contactRoutine.js";
import type { ModelUsageEvent, UsageEventRecorder } from "../../src/shared/domain/usageEventRecorder.js";
import {
  createAuditService,
  InMemoryConversationRepository,
  InMemoryMessageRepository,
} from "../support/fakes.js";
import { defaultAgentVoiceSettings, unpublishedAgentPublicIdentity } from "../../src/modules/agents/public.js";
import {
  ApplicationModuleCoordinator,
  createApplicationExtensionRegistry,
} from "../../src/app/composition/applicationModule.js";
import { createContactRoutineApplicationModule } from "../../src/app/composition/builtIn/contactRoutineModule.js";
import { createPublishedRoutineRegistrationSource } from "../../src/app/composition/routineDefinitionSource.js";
import { contactRoutineDefinition } from "../../src/modules/chat/services/routines/contactRoutine.js";
import { createRoutineTurnProvider } from "../../src/modules/routines/turnProvider.js";

const fallbackReplyComposer: FallbackReplyComposer = {
  async composeNoContext() {
    return { text: "No supporting material found.", declineReason: "content_gap" as const };
  },
};

/** A valid planner completion (JSON-in-text) for the given route. */
const planJson = (input: {
  route: "direct" | "retrieval";
  responseLanguage?: string;
  routineRankings?: Array<{ routineId: string; confidence: number; variables?: Record<string, unknown> }>;
  directiveClassifications?: Array<{ name: string; matched: boolean; confidence: number }>;
  pageRead?: {
    required: boolean;
    operation: "metadata" | "lookup" | "summarize" | "transform" | null;
    resolvedRequest: string | null;
  };
  quickReply?: unknown;
  openQuestion?: boolean;
  requestPresent?: boolean;
  isIdentityQuestion?: boolean;
}): string =>
  JSON.stringify({
    route: input.route,
    isIdentityQuestion: input.isIdentityQuestion ?? false,
    intentTopic: null,
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
    ...(input.pageRead ? { pageRead: input.pageRead } : {}),
    requestPresent: input.requestPresent ?? false,
    openQuestion: input.openQuestion ?? false,
    ...(input.quickReply === undefined ? {} : { quickReply: input.quickReply }),
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
}): TurnPlanGatewayFactory & {
  completeCalls: () => number;
  prompts: () => string[];
  workspaceContexts: () => LlmCapabilityResolveInput[];
} => {
  const prompts: string[] = [];
  const workspaceContexts: LlmCapabilityResolveInput[] = [];
  const complete = vi.fn(async (request: { prompt: string; systemPrompt?: string; signal?: AbortSignal }) => {
    // Everything the planner reads: standing rules (system) and the turn's request (user).
    prompts.push(`${request.systemPrompt ?? ""}\n\n${request.prompt}`);
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
      complete: complete,
      stream: vi.fn(),
    },
    input.recorder,
  );
  return {
    completeCalls: () => complete.mock.calls.length,
    prompts: () => prompts,
    workspaceContexts: () => workspaceContexts,
    async create(createInput) {
      workspaceContexts.push(createInput.workspaceContext);
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

const publishedRuntimeResolver = (
  snapshot: AgentRevision["snapshot"] = {
    customInstruction: "",
    directives: [],
    routines: [],
    contextVariableEnablements: [],
  },
): AgentRevisionRuntimeResolver => {
  const revision: AgentRevision = {
    id: "11111111-1111-4111-8111-111111111111",
    snapshot,
    sourceDraftGeneration: 1,
    sourceBasePublishedRevisionId: null,
    createdAt: new Date(0),
    publishedAt: new Date(0),
    publishedVersion: 1,
  };
  return new AgentRevisionRuntimeResolver({
    findCurrentPublished: async () => revision,
    findRevision: async () => revision,
  });
};

/** A published agent with no override or authored behavior; spread and override per test. */
const baseAgentRecord = (): AgentRecord => ({
  ...unpublishedAgentPublicIdentity(),
  voice: defaultAgentVoiceSettings(),
  id: "agent-1",
  workspaceId: "workspace-1",
  name: "Support",
  createdAt: new Date(0),
  updatedAt: new Date(0),
  customInstruction: "",
  suggestedQuestionsEnabled: true,
  assistantLinkUtmEnabled: true,
  citationDisplayEnabled: true,
  contactRequestsEnabled: false,
  webhookExportsEnabled: false,
  contactRequestDelivery: { recipientEmails: [], webhook: null },
  retrievalEnabled: true,
  sourceScope: { mode: "all" },
  skillSettings: {},
  logo: null,
  theme: { brand: "#000000", brandText: "#ffffff", surface: "#ffffff", text: "#000000" },
  branding: { hidePoweredBy: false, privacyPolicyUrl: null },
  greetingInstruction: "",
  assistantDefaultLocale: null,
  proactiveGreetingEnabled: false,
  mechanicsReplies: {},
  chatModelOverride: null,
  surfaceSettings: {
    authenticatedChat: { enabled: true },
    anonymousChat: { enabled: false, token: null },
    websiteEmbed: {
      enabled: false,
      token: null,
      allowedOrigins: [],
      launcherLabel: "Chat",
      launcherPosition: "bottom-right",
      theme: { brand: "#000000", brandText: "#ffffff", surface: "#ffffff", text: "#000000" },
      copy: {},
      expertOverrides: {},
      voiceCallsOffered: false,
    },
    extensions: {},
  },
  authoredDirectives: [],
});

const buildService = (input: {
  planner?: TurnPlanGatewayFactory;
  pipeline: Record<string, unknown>;
  chatGateway: ChatServiceOptions["chatGateway"];
  staged: ReturnType<typeof countingStagedPorts>;
  messageRepository?: InMemoryMessageRepository;
  conversationRepository?: InMemoryConversationRepository;
  conversationOwnershipReader?: ChatServiceOptions["conversationOwnershipReader"];
  directiveSteering?: ChatServiceOptions["directiveSteering"];
  routine?: {
    routineStore: ChatServiceOptions["routineStore"];
    routineProvider: ChatServiceOptions["routineProvider"];
  };
  conversationSummary?: string;
  turnPlanInterpretationContextSettings?: ChatServiceOptions["turnPlanInterpretationContextSettings"];
  contextVariableRepository?: ChatServiceOptions["contextVariableRepository"];
  agentService?: ChatServiceOptions["agentService"];
  agentRevisionRuntimeResolver?: ChatServiceOptions["agentRevisionRuntimeResolver"];
  clarification?: {
    clarifier: NonNullable<ChatServiceOptions["clarifier"]>;
    clarificationStore: NonNullable<ChatServiceOptions["clarificationStore"]>;
  };
  fallbackReplyComposer?: FallbackReplyComposer;
  assistantTurnPersistence?: ChatServiceOptions["assistantTurnPersistence"];
  quickReplyLaneEnabled?: boolean;
}): ChatService =>
  new ChatService({
    conversationRepository: input.conversationRepository ?? new InMemoryConversationRepository(),
    messageRepository: input.messageRepository ?? new InMemoryMessageRepository(),
    conversationOwnershipReader: input.conversationOwnershipReader,
    retrievalTurn: new RetrievalTurnController(input.pipeline as never),
    chatGateway: input.chatGateway,
    auditService: createAuditService(),
    turnRuntime: buildChatTurnRuntime({
      chatGateway: input.chatGateway,
      fallbackReplyComposer: input.fallbackReplyComposer ?? fallbackReplyComposer,
      skillOutcomeCapabilities: { supportsGroundedAnswer: () => true },
      ...(input.quickReplyLaneEnabled === undefined ? {} : { quickReplyLaneEnabled: input.quickReplyLaneEnabled }),
    }),
    turnRouter: input.staged.turnRouter,
    responseLanguageDetector: input.staged.responseLanguageDetector,
    directiveSteering: input.directiveSteering,
    agentService: input.agentService,
    agentRevisionRuntimeResolver: input.agentRevisionRuntimeResolver ?? publishedRuntimeResolver(),
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
    contextVariableRepository: input.contextVariableRepository,
    assistantTurnPersistence: input.assistantTurnPersistence,
    ...(input.planner
      ? {
          turnPlanCoordinator: new TurnPlanCoordinator(
            new TurnPlanService(input.planner),
            undefined,
            undefined,
            input.quickReplyLaneEnabled === undefined ? {} : { quickReplyLaneEnabled: input.quickReplyLaneEnabled },
          ),
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

  it("returns a receipt for the user message persisted by the turn", async () => {
    const staged = countingStagedPorts();
    const messageRepository = new InMemoryMessageRepository();
    const service = buildService({
      planner: plannerFactory({ completions: [planJson({ route: "direct" })] }),
      pipeline: directPipeline("thanks!"),
      chatGateway: pipelineChatGateway("You're welcome!"),
      staged,
      messageRepository,
    });

    const receipt = await service.answerWithReceipt({
      workspaceId: "workspace-1",
      query: "thanks!",
      stream: false,
    });
    const persistedUserMessage = await messageRepository.findByIdAndWorkspaceId(
      "workspace-1",
      receipt.userMessageId,
    );

    expect(persistedUserMessage).toMatchObject({
      id: receipt.userMessageId,
      conversationId: receipt.response.conversationId,
      role: "user",
      content: "thanks!",
    });
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

  it("passes the legacy-derived content capability to the live planner", async () => {
    const staged = countingStagedPorts();
    const planner = plannerFactory({ completions: [
      planJson({
        route: "direct",
        pageRead: { required: false, operation: null, resolvedRequest: null },
      }),
    ] });
    const service = buildService({
      planner,
      pipeline: directPipeline("summarize this page"),
      chatGateway: pipelineChatGateway("Page summary."),
      staged,
    });

    await service.answer({
      workspaceId: "workspace-1",
      query: "summarize this page",
      stream: false,
      pageContext: {
        pageUrl: "https://example.com/docs",
        content: "The current page contents.",
      },
    });

    expect(planner.prompts()[0]).toContain("Advertised page-read capability:");
    expect(planner.prompts()[0]).toContain("- mode: content");
    expect(planner.prompts()[0]).toContain("- supported operations: metadata, lookup, summarize");
  });

  it("keeps planner page-read capability null without page context or an advertisement", async () => {
    const staged = countingStagedPorts();
    const planner = plannerFactory({ completions: [planJson({ route: "direct" })] });
    const service = buildService({
      planner,
      pipeline: directPipeline("thanks!"),
      chatGateway: pipelineChatGateway("You're welcome!"),
      staged,
    });

    await service.answer({ workspaceId: "workspace-1", query: "thanks!", stream: false });

    expect(planner.prompts()[0]).not.toContain("Advertised page-read capability:");
    expect(planner.prompts()[0]).not.toContain('"pageRead"');
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

  it("keeps the staged fallback on the workspace tier when the overridden planner fails", async () => {
    const chatModelOverride = { provider: "openai" as const, model: "gpt-5.4-nano" };
    const staged = countingStagedPorts();
    const planner = plannerFactory({ completions: ["<<<not json>>>"] });
    const service = buildService({
      planner,
      pipeline: retrievalPipeline([]),
      chatGateway: pipelineChatGateway("Grounded [[1]]."),
      staged,
      agentService: { resolve: async () => ({ ...baseAgentRecord(), chatModelOverride }) },
    });

    await service.answer({ workspaceId: "workspace-1", query: "refund window?", stream: false });

    // The override reached the planner; the staged router and language detector
    // that recover from its failure resolve their own tier from the workspace alone.
    expect(planner.workspaceContexts()).toEqual([{ workspaceId: "workspace-1", capabilityOverride: chatModelOverride }]);
    expect(staged.routerClassify).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceContext: { workspaceId: "workspace-1" } }),
    );
    expect(staged.languageDetect).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceContext: { workspaceId: "workspace-1" } }),
    );
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
      agentRevisionRuntimeResolver: publishedRuntimeResolver(),
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

  it("stages the held-aside page for an active routine that binds page_context without planner help", async () => {
    const staged = countingStagedPorts();
    const routine: Routine = {
      id: "page.checkout",
      rootStepId: "inspect_page",
      steps: [{
        id: "inspect_page",
        kind: "skill",
        skillName: "checkout_lookup",
        inputBindings: {
          page: { kind: "contextVariableRef", contextVariable: "page_context" },
        },
      }],
      transitions: [],
    };
    let routineStagedContext: readonly StagedContext[] = [];
    const routineStore: NonNullable<ChatServiceOptions["routineStore"]> = {
      loadActive: async () => ({
        sessionId: "s",
        routineId: routine.id,
        path: [routine.rootStepId],
        variables: {},
        status: "active",
      }),
      save: async () => {},
      clear: async () => {},
    };
    const routineProvider: NonNullable<ChatServiceOptions["routineProvider"]> = {
      forTurn: async () => (({
        routines: [routine],
        activator: { activate: async () => null },
        runner: {
          resume: async ({ turn }: Parameters<ConversationRoutineRunner["resume"]>[0]) => {
            routineStagedContext = turn.stagedContext;
            return {
              response: { answer: "I inspected the checkout page." },
              nextState: null,
            };
          },
        },
      })),
    };
    const service = buildService({
      pipeline: directPipeline("inspect this checkout"),
      chatGateway: pipelineChatGateway("unused"),
      staged,
      routine: { routineStore, routineProvider },
    });

    await service.answer({
      workspaceId: "workspace-1",
      query: "inspect this checkout",
      stream: false,
      pageContext: {
        pageUrl: "https://example.test/checkout",
        content: "Checkout total: 42 EUR",
      },
    });

    expect(routineStagedContext).toContainEqual({
      kind: "context_variable",
      id: "page_context",
      data: {
        kind: "page_context",
        pageUrl: "https://example.test/checkout",
        content: "Checkout total: 42 EUR",
      },
      metadata: {
        variableName: "page_context",
        trustTier: "unverified",
      },
    });
  });

  it("does not leak the page into normal answering after a page-bound routine yields off-topic", async () => {
    const staged = countingStagedPorts();
    // The yielded turn falls through to normal answering on the direct path.
    staged.routerClassify.mockResolvedValue(
      { route: "direct", framing: { isIdentityQuestion: false } } as unknown as Awaited<
        ReturnType<typeof staged.routerClassify>
      >,
    );
    const routine: Routine = {
      id: "page.checkout",
      rootStepId: "inspect_page",
      steps: [{
        id: "inspect_page",
        kind: "skill",
        skillName: "checkout_lookup",
        inputBindings: {
          page: { kind: "contextVariableRef", contextVariable: "page_context" },
        },
      }],
      transitions: [],
    };
    const routineStore: NonNullable<ChatServiceOptions["routineStore"]> = {
      loadActive: async () => ({
        sessionId: "s",
        routineId: routine.id,
        path: [routine.rootStepId],
        variables: {},
        status: "active",
      }),
      save: async () => {},
      clear: async () => {},
    };
    const routineProvider: NonNullable<ChatServiceOptions["routineProvider"]> = {
      forTurn: async () => (({
        routines: [routine],
        activator: { activate: async () => null },
        runner: {
          resume: async () => ({
            // Off-topic decline: response/nextState are inert placeholders.
            response: { answer: "" },
            nextState: null,
            yielded: true,
          }),
        },
      })),
    };
    const complete = vi.fn(async (request: unknown) => {
      void request;
      return {
        text: "Our opening hours are 9-17.",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, quality: "actual" as const },
      };
    });
    const chatGateway = new ModelChatGateway(
      new ModelInferencePipelineService({
        metadata: { capability: "chat", provider: "openai", model: "gpt-answer" },
        complete,
        stream: vi.fn(() => ({
          textStream: (async function* () {
            yield "Our opening hours are 9-17.";
          })(),
          usage: Promise.resolve({ inputTokens: 10, outputTokens: 5, totalTokens: 15, quality: "actual" as const }),
        })),
      }),
    );
    const service = buildService({
      pipeline: directPipeline("what are your opening hours?"),
      chatGateway,
      staged,
      routine: { routineStore, routineProvider },
    });

    await service.answer({
      workspaceId: "workspace-1",
      query: "what are your opening hours?",
      stream: false,
      pageContext: {
        pageUrl: "https://example.test/checkout",
        content: "Checkout total: 42 EUR",
      },
    });

    const answerPrompts = complete.mock.calls
      .map((call) => JSON.stringify(call[0] ?? ""))
      .join("\n");
    expect(answerPrompts).not.toContain("Checkout total: 42 EUR");
    expect(answerPrompts).not.toContain("example.test/checkout");
  });

  it("does not stage the held-aside page for an active routine without a page_context binding", async () => {
    const staged = countingStagedPorts();
    const routine: Routine = {
      id: "account.lookup",
      rootStepId: "inspect_account",
      steps: [{
        id: "inspect_account",
        kind: "skill",
        skillName: "account_lookup",
        inputBindings: {
          plan: { kind: "contextVariableRef", contextVariable: "plan" },
        },
      }],
      transitions: [],
    };
    let routineStagedContext: readonly StagedContext[] = [];
    const routineStore: NonNullable<ChatServiceOptions["routineStore"]> = {
      loadActive: async () => ({
        sessionId: "s",
        routineId: routine.id,
        path: [routine.rootStepId],
        variables: {},
        status: "active",
      }),
      save: async () => {},
      clear: async () => {},
    };
    const routineProvider: NonNullable<ChatServiceOptions["routineProvider"]> = {
      forTurn: async () => ({
        routines: [routine],
        activator: { activate: async () => null },
        runner: {
          resume: async ({ turn }: Parameters<ConversationRoutineRunner["resume"]>[0]) => {
            routineStagedContext = turn.stagedContext;
            return {
              response: { answer: "I inspected the account." },
              nextState: null,
            };
          },
        },
      }),
    };
    const service = buildService({
      pipeline: directPipeline("inspect my account"),
      chatGateway: pipelineChatGateway("unused"),
      staged,
      routine: { routineStore, routineProvider },
    });

    await service.answer({
      workspaceId: "workspace-1",
      query: "inspect my account",
      stream: false,
      pageContext: {
        pageUrl: "https://example.test/checkout",
        content: "Checkout total: 42 EUR",
      },
    });

    expect(routineStagedContext.some((entry) => entry.id === "page_context")).toBe(false);
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

  it("excludes a disabled authored directive from the turn plan's directive candidates (#1111)", async () => {
    const agentRecord: AgentRecord = {
      ...baseAgentRecord(),
      authoredDirectives: [
        {
          id: "directive-live",
          agentId: "agent-1",
          name: "live-tone",
          condition: { kind: "contextual", description: "when the visitor asks about tone" },
          action: "Use the live agent tone.",
          priority: null,
          binding: null,
          lifecycle: null,
          requiredCapabilities: [],
          dependsOn: [],
          excludes: [],
          routes: [],
          surfaces: [],
          tags: [],
          description: null,
          enabled: true,
          metadata: {},
          createdAt: new Date(0),
          updatedAt: new Date(0),
        },
        {
          id: "directive-disabled",
          agentId: "agent-1",
          name: "disabled-tone",
          condition: { kind: "contextual", description: "when the visitor asks about tone" },
          action: "Use the disabled agent tone.",
          priority: null,
          binding: null,
          lifecycle: null,
          requiredCapabilities: [],
          dependsOn: [],
          excludes: [],
          routes: [],
          surfaces: [],
          tags: [],
          description: null,
          enabled: false,
          metadata: {},
          createdAt: new Date(0),
          updatedAt: new Date(0),
        },
      ],
    };
    const planner = plannerFactory({
      completions: [planJson({
        route: "direct",
        directiveClassifications: [{ name: "live-tone", matched: false, confidence: 0.2 }],
      })],
    });
    const service = buildService({
      planner,
      pipeline: directPipeline("thanks!"),
      chatGateway: pipelineChatGateway("You're welcome!"),
      staged: countingStagedPorts(),
      directiveSteering: createRouteScopedDirectiveSteering({
        capabilityPolicy: new DefaultAllowCapabilityPolicy(),
        registrations: [],
      }),
      agentService: { resolve: async () => agentRecord },
      agentRevisionRuntimeResolver: publishedRuntimeResolver({
        customInstruction: agentRecord.customInstruction,
        directives: agentRecord.authoredDirectives ?? [],
        routines: [],
        contextVariableEnablements: [],
      }),
    });

    await service.answer({ workspaceId: "workspace-1", query: "what's your tone?", stream: false });

    const prompt = planner.prompts()[0] ?? "";
    expect(prompt).toContain('"name": "live-tone"');
    expect(prompt).not.toContain("disabled-tone");
  });

  it("resolves the planner through the agent's chat model override, matching the answer call", async () => {
    const chatModelOverride = { provider: "openai" as const, model: "gpt-5.4-nano" };
    const planner = plannerFactory({ completions: [planJson({ route: "direct" })] });
    const service = buildService({
      planner,
      pipeline: directPipeline("thanks!"),
      chatGateway: pipelineChatGateway("You're welcome!"),
      staged: countingStagedPorts(),
      agentService: { resolve: async () => ({ ...baseAgentRecord(), chatModelOverride }) },
    });

    await service.answer({ workspaceId: "workspace-1", query: "thanks", stream: false });

    expect(planner.workspaceContexts()).toEqual([
      { workspaceId: "workspace-1", capabilityOverride: chatModelOverride },
    ]);
  });

  it("feeds the turn's resolved visitor context into the planner's directive classification", async () => {
    const steering = createRouteScopedDirectiveSteering({
      capabilityPolicy: new DefaultAllowCapabilityPolicy(),
      registrations: [
        {
          directive: {
            name: "concierge",
            condition: { kind: "contextual", description: "the visitor's cart is worth more than 100" },
            action: "Offer concierge checkout.",
          },
        },
      ],
    });
    const planner = plannerFactory({
      completions: [
        planJson({
          route: "retrieval",
          directiveClassifications: [{ name: "concierge", matched: true, confidence: 0.9 }],
        }),
      ],
    });
    const service = buildService({
      planner,
      pipeline: retrievalPipeline([]),
      chatGateway: pipelineChatGateway("Grounded [[1]]."),
      staged: countingStagedPorts(),
      directiveSteering: steering,
      contextVariableRepository: {
        resolveForAgent: async () => [
          { name: "cart_value", value: 120, surfacing: "on_reference" },
          { name: "customer_email", value: "buyer@example.com", surfacing: "on_reference", sensitive: true },
        ],
        resolveForEnablements: async () => [
          { name: "cart_value", value: 120, surfacing: "on_reference" },
          { name: "customer_email", value: "buyer@example.com", surfacing: "on_reference", sensitive: true },
        ],
      },
      agentRevisionRuntimeResolver: publishedRuntimeResolver({
        customInstruction: "",
        directives: [],
        routines: [],
        contextVariableEnablements: [{
          id: "33333333-3333-4333-8333-333333333333",
          agentId: "workspace-1",
          variableId: "44444444-4444-4444-8444-444444444444",
          source: "pushed",
          resolverSkillId: null,
          maxAgeSeconds: null,
          resolverTimeoutMs: null,
          surfacing: "on_reference",
          enabled: true,
          createdAt: new Date(0),
          updatedAt: new Date(0),
        }],
      }),
    });

    await service.answer({
      workspaceId: "workspace-1",
      query: "can you help me check out?",
      stream: false,
    });

    const prompt = planner.prompts()[0] ?? "";
    expect(prompt).toContain("Visitor context resolved for this turn");
    expect(prompt).toContain('"cart_value": 120');
    // The snapshot is the redaction boundary: a sensitive value never reaches a prompt.
    expect(prompt).not.toContain("buyer@example.com");
    expect(prompt).toContain("[redacted]");
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
          // "r1": the planner sees candidates by position, never by real id — this
          // turn has exactly one candidate ("contact.request", registered below).
          routineRankings: [{
            routineId: "r1",
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
        runner: { resume: resume },
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

/**
 * A page-context answer whose envelope commits a decline but writes no text is worded by
 * the grounded-miss composer; the reason stays the one the page envelope committed, so
 * only a content gap hands the visitor to a person (#1499 review round 3).
 */
describe("a page-context decline committed without text", () => {
  const blankPageDeclineGateway = (outcome: "no_support" | "out_of_scope", attempts: string[]): ChatGateway => {
    const raw = JSON.stringify({
      coverage: "unanswered_insufficient_evidence",
      requestFocus: "the plan prices",
      outcome,
      answer: "",
      v: 2,
      claims: [],
      suggestions: [],
      grounding: "degraded",
    });
    return {
      async answer(input) {
        attempts.push(input.usageContext.attemptKey);
        return raw;
      },
      async *streamAnswer(input) {
        attempts.push(input.usageContext.attemptKey);
        yield raw;
      },
    };
  };

  const capturingAssistantTurnPersistence = () => ({
    completeAssistantTurn: vi.fn(async (input) => ({ message: {
      id: input.assistantMessage.id!,
      conversationId: input.assistantMessage.conversationId,
      workspaceId: input.assistantMessage.workspaceId,
      role: "assistant" as const,
      content: input.assistantMessage.content,
      metadata: input.assistantMessage.metadata,
      skillName: input.assistantMessage.skillName,
      skillOutcome: input.assistantMessage.skillOutcome,
      skillStatus: input.assistantMessage.skillStatus,
      createdAt: new Date(),
    }, committedFacts: { insertedActionTypes: [], decisionCreated: false, ownershipChanged: false } })),
  } satisfies NonNullable<ChatServiceOptions["assistantTurnPersistence"]>);

  it.each([
    {
      committed: "out_of_scope",
      composedReason: "content_gap",
      skillOutcome: SKILL_TURN_OUTCOME.RETRIEVAL_OUT_OF_SCOPE.outcome,
      handsOff: false,
    },
    {
      committed: "no_support",
      composedReason: "out_of_scope",
      skillOutcome: SKILL_TURN_OUTCOME.RETRIEVAL_NO_CONTEXT.outcome,
      handsOff: true,
    },
  ] as const)("keeps a committed $committed when the decline model calls it $composedReason", async (testCase) => {
    for (const stream of [false, true]) {
      const attempts: string[] = [];
      const assistantTurnPersistence = capturingAssistantTurnPersistence();
      const service = buildService({
        planner: plannerFactory({ completions: [planJson({
          route: "retrieval",
          pageRead: { required: true, operation: "lookup", resolvedRequest: "the plan prices" },
        })] }),
        pipeline: retrievalPipeline([]),
        chatGateway: blankPageDeclineGateway(testCase.committed, attempts),
        staged: countingStagedPorts(),
        agentService: { resolve: async () => ({ ...baseAgentRecord(), handoffOnRetrievalMiss: true }) },
        fallbackReplyComposer: {
          async composeNoContext() {
            return { text: "Prices are not on this page.", declineReason: testCase.composedReason };
          },
        },
        assistantTurnPersistence,
      });
      const request = {
        workspaceId: "workspace-1",
        query: "How much does the Pro plan cost?",
        stream,
        pageContext: { pageUrl: "https://example.com/pricing", content: "Plans and features, without prices." },
      };

      if (stream) {
        for await (const _event of service.streamAnswer(request)) {
          // Drain the public stream to its lifecycle boundary.
        }
      } else {
        await service.answer(request);
      }

      // The answer came from the visitor's page: nothing was retrieved, the page was read.
      expect(attempts).toEqual([stream ? "stream_page_context" : "page_context"]);
      const persisted = vi.mocked(assistantTurnPersistence.completeAssistantTurn).mock.calls[0][0];
      expect(persisted.assistantMessage.content).toBe("Prices are not on this page.");
      expect(persisted.assistantMessage.skillOutcome).toBe(testCase.skillOutcome);
      if (testCase.handsOff) {
        expect(persisted.ownershipHandoff).toEqual({ reason: "retrieval_miss" });
        expect(persisted.actions).toContainEqual(expect.objectContaining({ type: HANDOFF_NOTIFY_ACTION_TYPE }));
      } else {
        expect(persisted.ownershipHandoff).toBeNull();
        expect(persisted.actions ?? []).not.toContainEqual(expect.objectContaining({ type: HANDOFF_NOTIFY_ACTION_TYPE }));
      }
    }
  });
});

describe("chat service quick-reply lane", () => {
  const greeting = { kind: "greeting", language: "en", text: "Hello! What can I help you with today?" } as const;

  const modelCallOperations = (response: { turnTrace?: { spine: { stages: Array<{ kind: string; outputs?: Record<string, unknown> }> } } }) =>
    ((response.turnTrace?.spine.stages.find((stage) => stage.kind === "model_calls")?.outputs?.modelCalls ?? []) as Array<{ operation: string }>)
      .map((call) => call.operation)
      .sort();

  const composeStage = (response: { turnTrace?: { spine: { stages: Array<{ kind: string; outputs?: Record<string, unknown> }> } } }) =>
    response.turnTrace?.spine.stages.find((stage) => stage.kind === "compose");

  const alwaysOnSignOff = {
    name: "sign-off",
    condition: { kind: "always" as const },
    action: "Close every reply with a short, friendly invitation to ask more.",
  };

  it("answers a greeting with the planner's own reply in exactly one model call", async () => {
    const staged = countingStagedPorts();
    const messageRepository = new InMemoryMessageRepository();
    const planner = plannerFactory({ completions: [planJson({ route: "direct", quickReply: greeting })] });
    const service = buildService({
      planner,
      pipeline: directPipeline("hi there"),
      chatGateway: pipelineChatGateway("A composed reply that must not appear."),
      staged,
      messageRepository,
    });

    const response = await service.answer({ workspaceId: "workspace-1", query: "hi there", stream: false });

    expect(response.answer).toBe(greeting.text);
    expect(response.route).toMatchObject({ type: "direct" });
    expect(response.answerCoverage).toMatchObject({ availability: "not_recorded" });
    expect(planner.completeCalls()).toBe(1);
    expect(staged.routerClassify).not.toHaveBeenCalled();
    expect(staged.languageDetect).not.toHaveBeenCalled();
    expect(response.turnTrace?.summary).toMatchObject({ totalLlmCalls: 1 });
    expect(modelCallOperations(response)).toEqual(["turn_planning"]);
    expect(composeStage(response)?.outputs).toMatchObject({ source: "turn_planning", quickReplyKind: "greeting", quickReplyWording: "planner" });
    expect(composeStage(response)?.outputs).not.toHaveProperty("modelCallIds");
    const messages = await messageRepository.listByConversationId("workspace-1", response.conversationId);
    expect(messages.map((message) => [message.role, message.content])).toEqual([
      ["user", "hi there"],
      ["assistant", greeting.text],
    ]);
  });

  it("composes a greeting in two model calls, with no quick-reply wording in the planner prompt, when the lane is switched off", async () => {
    const staged = countingStagedPorts();
    // A planner that still writes a quick reply (a cached prompt, a mixed deploy) parses, and is ignored.
    const planner = plannerFactory({ completions: [planJson({ route: "direct", quickReply: greeting })] });
    const service = buildService({
      planner,
      pipeline: directPipeline("hi there"),
      chatGateway: pipelineChatGateway("Hi! How can I help?"),
      staged,
      quickReplyLaneEnabled: false,
      directiveSteering: createRouteScopedDirectiveSteering({
        capabilityPolicy: new DefaultAllowCapabilityPolicy(),
        registrations: [{ directive: alwaysOnSignOff }],
      }),
      agentRevisionRuntimeResolver: publishedRuntimeResolver({
        customInstruction: "You are Pip, Acme's cheerful support assistant.",
        directives: [],
        routines: [],
        contextVariableEnablements: [],
      }),
    });

    const response = await service.answer({ workspaceId: "workspace-1", query: "hi there", stream: false });

    expect(response.answer).toBe("Hi! How can I help?");
    expect(response.route).toMatchObject({ type: "direct" });
    expect(modelCallOperations(response)).toEqual(["answer", "turn_planning"]);
    expect(composeStage(response)?.outputs).not.toHaveProperty("quickReplyKind");
    expect(staged.routerClassify).not.toHaveBeenCalled();
    const prompt = planner.prompts()[0] ?? "";
    expect(prompt).not.toContain("Quick Reply Rules");
    expect(prompt).not.toContain("Standing Instructions For Any Reply You Write");
    expect(prompt).not.toContain("quickReply");
  });

  it("streams the planner's reply as committed text after one model call", async () => {
    const staged = countingStagedPorts();
    const planner = plannerFactory({ completions: [planJson({ route: "direct", quickReply: greeting })] });
    const service = buildService({
      planner,
      pipeline: directPipeline("hi there"),
      chatGateway: pipelineChatGateway("A composed reply that must not appear."),
      staged,
    });

    const events: ChatStreamEvent[] = [];
    for await (const event of service.streamAnswer({ workspaceId: "workspace-1", query: "hi there", stream: true })) {
      events.push(event);
    }

    const composingAt = events.findIndex((event) => event.type === "status" && event.stage === "composing");
    const firstChunkAt = events.findIndex((event) => event.type === "chunk");
    const doneAt = events.findIndex((event) => event.type === "done");
    expect(composingAt).toBeGreaterThanOrEqual(0);
    expect(firstChunkAt).toBeGreaterThan(composingAt);
    expect(doneAt).toBeGreaterThan(firstChunkAt);
    const streamed = events.flatMap((event) => (event.type === "chunk" ? [event.text] : [])).join("");
    expect(streamed).toBe(greeting.text);
    const done = events[doneAt] as Extract<ChatStreamEvent, { type: "done" }>;
    expect(done.route).toMatchObject({ type: "direct" });
    expect(done.answer).toBe(greeting.text);
    expect(done.answerCoverage).toMatchObject({ availability: "not_recorded" });
    expect(done.turnTrace?.summary).toMatchObject({ totalLlmCalls: 1 });
    expect(composeStage(done)?.outputs).toMatchObject({ source: "turn_planning", quickReplyKind: "greeting" });
    expect(planner.completeCalls()).toBe(1);
  });

  it("keeps the planner's reply when the turn's answer rules are the always-on directives it wrote under", async () => {
    const planner = plannerFactory({ completions: [planJson({ route: "direct", quickReply: greeting })] });
    const service = buildService({
      planner,
      pipeline: directPipeline("hi there"),
      chatGateway: pipelineChatGateway("A composed reply that must not appear."),
      staged: countingStagedPorts(),
      directiveSteering: createRouteScopedDirectiveSteering({
        capabilityPolicy: new DefaultAllowCapabilityPolicy(),
        registrations: [{ directive: alwaysOnSignOff }],
      }),
    });

    const response = await service.answer({ workspaceId: "workspace-1", query: "hi there", stream: false });

    expect(planner.prompts()[0]).toContain("Standing Instructions For Any Reply You Write");
    expect(planner.prompts()[0]).toContain(alwaysOnSignOff.action);
    expect(response.answer).toBe(greeting.text);
    expect(modelCallOperations(response)).toEqual(["turn_planning"]);
  });

  it("gives the planner the agent's custom instruction for the reply it writes", async () => {
    const customInstruction = "You are Pip, Acme's cheerful support assistant.";
    const planner = plannerFactory({ completions: [planJson({ route: "direct", quickReply: greeting })] });
    const service = buildService({
      planner,
      pipeline: directPipeline("hi there"),
      chatGateway: pipelineChatGateway("A composed reply that must not appear."),
      staged: countingStagedPorts(),
      agentRevisionRuntimeResolver: publishedRuntimeResolver({
        customInstruction,
        directives: [],
        routines: [],
        contextVariableEnablements: [],
      }),
    });

    const response = await service.answer({ workspaceId: "workspace-1", query: "hi there", stream: false });

    const prompt = planner.prompts()[0] ?? "";
    const standingBlock = prompt.slice(prompt.indexOf("Standing Instructions For Any Reply You Write"));
    expect(prompt).toContain("Standing Instructions For Any Reply You Write");
    expect(standingBlock).toContain(customInstruction);
    expect(response.answer).toBe(greeting.text);
  });

  it("speaks the agent's authored line for the mechanic instead of the planner's words", async () => {
    const mechanicsReplies = {
      en: { greeting: ["Hi! I'm here whenever you need me."], thanks: [], farewell: [], acknowledgement: [] },
    };
    const planner = plannerFactory({
      completions: [planJson({ route: "direct", quickReply: { kind: "greeting", language: "en", text: "Hello! What can I help you with today?" } })],
    });
    const service = buildService({
      planner,
      pipeline: directPipeline("hi there"),
      chatGateway: pipelineChatGateway("A composed reply that must not appear."),
      staged: countingStagedPorts(),
      agentService: { resolve: async () => ({ ...baseAgentRecord(), mechanicsReplies }) },
    });

    const response = await service.answer({ workspaceId: "workspace-1", query: "hi there", stream: false });

    expect(response.answer).toBe("Hi! I'm here whenever you need me.");
    expect(modelCallOperations(response)).toEqual(["turn_planning"]);
    expect(composeStage(response)?.outputs).toMatchObject({
      source: "turn_planning",
      quickReplyKind: "greeting",
      quickReplyWording: "authored",
    });
  });

  it("composes the reply, speaking neither the planner's words nor an authored line, when the planner names its language instead of tagging it", async () => {
    const mechanicsReplies = {
      en: { greeting: ["Hi! I'm here whenever you need me."], thanks: [], farewell: [], acknowledgement: [] },
    };
    const planner = plannerFactory({
      completions: [planJson({ route: "direct", quickReply: { kind: "greeting", language: "English", text: "Hello! What can I help you with today?" } })],
    });
    const service = buildService({
      planner,
      pipeline: directPipeline("hi there"),
      chatGateway: pipelineChatGateway("Hi! How can I help?"),
      staged: countingStagedPorts(),
      agentService: { resolve: async () => ({ ...baseAgentRecord(), mechanicsReplies }) },
    });

    const response = await service.answer({ workspaceId: "workspace-1", query: "hi there", stream: false });

    expect(response.answer).toBe("Hi! How can I help?");
    expect(response.route).toMatchObject({ type: "direct" });
    expect(modelCallOperations(response)).toEqual(["answer", "turn_planning"]);
    expect(composeStage(response)?.outputs).not.toHaveProperty("quickReplyWording");
  });

  it("composes the reply when the planner's own words carry a price", async () => {
    const planner = plannerFactory({
      completions: [planJson({
        route: "direct",
        quickReply: { kind: "greeting", language: "en", text: "Welcome! Pro costs $99 and is SOC 2 certified." },
      })],
    });
    const service = buildService({
      planner,
      pipeline: directPipeline("Hello"),
      chatGateway: pipelineChatGateway("Hello! How can I help?"),
      staged: countingStagedPorts(),
    });

    const response = await service.answer({ workspaceId: "workspace-1", query: "Hello", stream: false });

    expect(response.answer).toBe("Hello! How can I help?");
    expect(modelCallOperations(response)).toEqual(["answer", "turn_planning"]);
  });

  it("composes a greeting that carries a request instead of answering only the greeting", async () => {
    const planner = plannerFactory({
      completions: [planJson({ route: "direct", requestPresent: true, quickReply: { kind: "greeting", language: "en", text: "Good morning!" } })],
    });
    const service = buildService({
      planner,
      pipeline: directPipeline("Good morning! I'd like to cancel my subscription."),
      chatGateway: pipelineChatGateway("Good morning! I can help you cancel your subscription."),
      staged: countingStagedPorts(),
    });

    const response = await service.answer({
      workspaceId: "workspace-1",
      query: "Good morning! I'd like to cancel my subscription.",
      stream: false,
    });

    expect(response.answer).toBe("Good morning! I can help you cancel your subscription.");
    expect(modelCallOperations(response)).toEqual(["answer", "turn_planning"]);
    expect(composeStage(response)?.outputs).not.toHaveProperty("source");
  });

  it("composes the reply when the planner marks the assistant's question as still open", async () => {
    const planner = plannerFactory({
      completions: [planJson({ route: "direct", openQuestion: true, quickReply: { kind: "acknowledgement", language: "en", text: "Got it." } })],
    });
    const service = buildService({
      planner,
      pipeline: directPipeline("ok"),
      chatGateway: pipelineChatGateway("Which plan do you mean, Pro or Team?"),
      staged: countingStagedPorts(),
    });

    const response = await service.answer({ workspaceId: "workspace-1", query: "ok", stream: false });

    expect(response.answer).toBe("Which plan do you mean, Pro or Team?");
    expect(modelCallOperations(response)).toEqual(["answer", "turn_planning"]);
    expect(composeStage(response)?.outputs).not.toHaveProperty("source");
  });

  it("composes the reply when a conditional answer directive applies to the turn", async () => {
    const planner = plannerFactory({
      completions: [
        planJson({
          route: "direct",
          directiveClassifications: [{ name: "first-visit-welcome", matched: true, confidence: 0.95 }],
          quickReply: greeting,
        }),
      ],
    });
    const service = buildService({
      planner,
      pipeline: directPipeline("hi there"),
      chatGateway: pipelineChatGateway("Welcome! Here is our first-visit offer."),
      staged: countingStagedPorts(),
      directiveSteering: createRouteScopedDirectiveSteering({
        capabilityPolicy: new DefaultAllowCapabilityPolicy(),
        registrations: [
          { directive: alwaysOnSignOff },
          {
            directive: {
              name: "first-visit-welcome",
              condition: { kind: "contextual", description: "the visitor greets the assistant for the first time" },
              action: "Mention the first-visit offer.",
            },
          },
        ],
      }),
    });

    const response = await service.answer({ workspaceId: "workspace-1", query: "hi there", stream: false });

    expect(response.answer).toBe("Welcome! Here is our first-visit offer.");
    expect(modelCallOperations(response)).toEqual(["answer", "turn_planning"]);
    expect(composeStage(response)?.outputs).not.toHaveProperty("source");
  });

  it("composes the reply when the planner returns kind none", async () => {
    const planner = plannerFactory({ completions: [planJson({ route: "direct", quickReply: { kind: "none", text: "" } })] });
    const service = buildService({
      planner,
      pipeline: directPipeline("hi there"),
      chatGateway: pipelineChatGateway("Hi! How can I help?"),
      staged: countingStagedPorts(),
    });

    const response = await service.answer({ workspaceId: "workspace-1", query: "hi there", stream: false });

    expect(response.answer).toBe("Hi! How can I help?");
    expect(modelCallOperations(response)).toEqual(["answer", "turn_planning"]);
  });

  it("composes the reply on an identity question even when the planner wrote one", async () => {
    const planner = plannerFactory({
      completions: [planJson({ route: "direct", isIdentityQuestion: true, quickReply: greeting })],
    });
    const service = buildService({
      planner,
      pipeline: directPipeline("hi, who are you?"),
      chatGateway: pipelineChatGateway("I'm Support, Acme's assistant."),
      staged: countingStagedPorts(),
    });

    const response = await service.answer({ workspaceId: "workspace-1", query: "hi, who are you?", stream: false });

    expect(response.answer).toBe("I'm Support, Acme's assistant.");
    expect(modelCallOperations(response)).toEqual(["answer", "turn_planning"]);
  });

  it("composes the reply when the planner's quick reply is malformed, still routing from the plan", async () => {
    const staged = countingStagedPorts();
    const planner = plannerFactory({
      completions: [planJson({ route: "direct", quickReply: { kind: "greeting", language: "en", text: "   " } })],
    });
    const service = buildService({
      planner,
      pipeline: directPipeline("hi there"),
      chatGateway: pipelineChatGateway("Hi! How can I help?"),
      staged,
    });

    const response = await service.answer({ workspaceId: "workspace-1", query: "hi there", stream: false });

    expect(response.answer).toBe("Hi! How can I help?");
    expect(response.route).toMatchObject({ type: "direct" });
    expect(modelCallOperations(response)).toEqual(["answer", "turn_planning"]);
    expect(staged.routerClassify).not.toHaveBeenCalled();
    expect(staged.languageDetect).not.toHaveBeenCalled();
  });

  it("leaves a human-owned conversation's turn unchanged: no plan and no reply", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const conversation = await conversationRepository.create({ workspaceId: "workspace-1" });
    const planner = plannerFactory({ completions: [planJson({ route: "direct", quickReply: greeting })] });
    const service = buildService({
      planner,
      pipeline: directPipeline("hi there"),
      chatGateway: pipelineChatGateway("A composed reply that must not appear."),
      staged: countingStagedPorts(),
      conversationRepository,
      conversationOwnershipReader: {
        load: vi.fn(async () => ({
          conversationId: conversation.id,
          workspaceId: "workspace-1",
          state: "human_owned" as const,
          ownerAccountId: "account-1",
          ownerUserId: "user-1",
          ownerProfile: null,
          ownerStoredLabel: "Operator",
          reason: "operator_takeover",
          version: 1,
          takenOverAt: new Date(0),
          createdAt: new Date(0),
          updatedAt: new Date(0),
        })),
      },
    });

    const response = await service.answer({
      workspaceId: "workspace-1",
      conversationId: conversation.id,
      query: "hi there",
      stream: false,
    });

    expect(response.answer).toBe("");
    expect(response.ownership).toEqual({ state: "human_owned", suppressed: true });
    expect(planner.completeCalls()).toBe(0);
  });

  it("never uses a planner reply while a routine is active: the planner is bypassed", async () => {
    const planner = plannerFactory({ completions: [planJson({ route: "direct", quickReply: greeting })] });
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
      pipeline: directPipeline("hi there"),
      chatGateway: pipelineChatGateway("unused"),
      staged: countingStagedPorts(),
      routine: { routineStore, routineProvider },
    });

    const response = await service.answer({ workspaceId: "workspace-1", query: "hi there", stream: false });

    expect(response.answer).toContain("What is your email?");
    expect(response.answer).not.toContain(greeting.text);
    expect(planner.completeCalls()).toBe(0);
  });
});

// #1362: every live conversation is bound to the release it started on, and a built-in
// routine (the contact routine) is never frozen into that release. Resuming it on the
// visitor's next message must read the built-in registration, not fail the snapshot lookup.
describe("chat service built-in routine resume on a revision-bound conversation", () => {
  const builtInRegistrations = (): RoutineRegistration[] => {
    const registry = createApplicationExtensionRegistry();
    new ApplicationModuleCoordinator({ logger: { error: () => {} }, registry }).apply([
      createContactRoutineApplicationModule(),
    ]);
    return registry.routineRegistrations;
  };

  it("resumes the active built-in contact routine on the visitor's next message", async () => {
    const staged = countingStagedPorts();
    const release: AgentRevision = {
      id: "11111111-1111-4111-8111-111111111111",
      snapshot: { customInstruction: "", directives: [], routines: [], contextVariableEnablements: [] },
      sourceDraftGeneration: 1,
      sourceBasePublishedRevisionId: null,
      createdAt: new Date(0),
      publishedAt: new Date(0),
      publishedVersion: 1,
    };
    const revisionReader = {
      findCurrentPublished: vi.fn(async () => release),
      findRevision: vi.fn(async () => release),
    };
    const routineProvider = createRoutineTurnProvider({
      agentSkillRepository: { listByAgent: vi.fn(async () => []) },
      capabilityPolicy: new DefaultAllowCapabilityPolicy(),
      clusteringEmbeddings: {} as never,
      embeddingModelForWorkspace: vi.fn(async () => "unused"),
      logger: { debug: vi.fn(), warn: vi.fn() },
      publishedRoutineSource: createPublishedRoutineRegistrationSource({
        listActiveByAgent: vi.fn(async () => []),
        listVersionsByAgent: vi.fn(async () => []),
        findPinnedById: vi.fn(async () => null),
        findById: vi.fn(async () => null),
      }, { revisionReader }),
      routineDefinitionRepository: {} as never,
      routineInvocableSkillNames: { listByKindForAgent: vi.fn(async () => ({ webhook: [], customer_email: [], slack: [] })) } as never,
      routineRegistrations: builtInRegistrations(),
      routineTriggerEmbeddingService: { persistPublished: vi.fn() },
      skillExecutorRegistry: {} as never,
      turnPlanAdapters: {
        activator: ({ fallback }) => fallback,
        reentryGate: ({ fallback }) => fallback,
        slotCorrection: ({ fallback }) => fallback,
      },
    });
    const saved: unknown[] = [];
    const routineStore: NonNullable<ChatServiceOptions["routineStore"]> = {
      loadActive: async ({ sessionId }) => ({
        sessionId,
        routineId: contactRoutineDefinition.id,
        path: ["ask_email"],
        variables: {},
        status: "active",
      }),
      save: async (state) => { saved.push(state); },
      clear: async () => {},
    };
    const service = buildService({
      pipeline: directPipeline("guest@example.com"),
      chatGateway: pipelineChatGateway("Where can someone reach you?"),
      staged,
      agentRevisionRuntimeResolver: new AgentRevisionRuntimeResolver(revisionReader),
      routine: { routineStore, routineProvider },
    });

    const response = await service.answer({ workspaceId: "workspace-1", query: "guest@example.com", stream: false });

    expect(response.answer).toContain("Where can someone reach you?");
    // The conversation is bound to the release, so the routine catalog is read from it.
    expect(revisionReader.findRevision).toHaveBeenCalledWith(expect.objectContaining({ revisionId: release.id }));
    expect(saved).toEqual([expect.objectContaining({ routineId: contactRoutineDefinition.id, status: "active" })]);
  });
});
