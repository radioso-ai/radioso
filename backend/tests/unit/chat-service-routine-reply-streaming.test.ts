import { describe, expect, it, vi } from "vitest";

import type {
  ConversationRoutineRunEffects,
  ConversationRoutineRunner,
  PendingRenderableTurn,
  RenderableTurn,
  Routine,
  RoutineState,
} from "@radioso/conversation-contract";
import { createConversationEngine, DefaultRoutineRunner } from "@radioso/conversation-engine";
import { RoutineStepRenderer, type RoutineRegistration } from "@radioso/conversation-defaults";
import {
  RoutineSkillExecutorDispatcher,
  StaticRoutineSkillResolver,
} from "../../src/modules/routines/skillDispatcher.js";
import {
  retrievalContextSkillDefinition,
  SkillExecutorRegistry,
  type SkillDefinition,
  type SkillExecutorPort,
  type SkillOutcome,
} from "../../src/modules/skills/public.js";
import type { RetrievalPipelineResult } from "../../src/modules/retrieval/public.js";
import { WEBHOOK_SKILLS_ADAPTER } from "../../src/modules/webhookSkills/public.js";

import {
  ChatService,
  ChatTurnDisconnectAbortError,
  type ChatGateway,
  type ChatRoutineProvider,
  type ChatServiceOptions,
  type ChatStreamEvent,
} from "../../src/modules/chat/services/chatService.js";
import type { ChatGatewayInput } from "../../src/modules/chat/contracts/chatGateway.js";
import { sendChatSse } from "../../src/app/http/presenters/chatPresenter.js";
import { buildChatTurnRuntime } from "../../src/modules/chat/services/chatTurnRuntime.js";
import { RetrievalTurnController } from "../../src/modules/chat/services/retrievalTurnDispatch.js";
import type { FallbackReplyComposer } from "../../src/modules/chat/services/fallbackReplyComposer.js";
import type { AgentRevision } from "../../src/modules/agents/agentRevision.js";
import {
  ApplicationModuleCoordinator,
  createApplicationExtensionRegistry,
} from "../../src/app/composition/applicationModule.js";
import { createContactRoutineApplicationModule } from "../../src/app/composition/builtIn/contactRoutineModule.js";
import { createPublishedRoutineRegistrationSource } from "../../src/app/composition/routineDefinitionSource.js";
import { contactRoutineDefinition } from "../../src/modules/chat/services/routines/contactRoutine.js";
import { createRoutineTurnProvider } from "../../src/modules/routines/turnProvider.js";
import { DefaultAllowCapabilityPolicy } from "../../src/shared/domain/capabilityPolicy.js";
import {
  createAuditService,
  InMemoryAgentRepository,
  InMemoryConversationRepository,
  InMemoryMessageRepository,
  pinExistingConversationsToPublishedRevisions,
  publishedRevisionResolverFixture,
} from "../support/fakes.js";

const fallbackReplyComposer: FallbackReplyComposer = {
  async composeNoContext() {
    return { text: "I couldn't find that.", declineReason: "content_gap" };
  },
};

/** A turn that falls through the routine attempt answers directly, with no retrieval. */
const directAnswerPipeline = {
  async interpret(input: { workspaceId: string; query: string }) {
    return {
      request: { workspaceId: input.workspaceId, query: input.query, history: [] },
      traceStartedAtMs: Date.now(),
      context: {
        startedAt: Date.now(),
        durationMs: 1,
        result: {
          request: { workspaceId: input.workspaceId, query: input.query, history: [] },
          settings: {
            workspaceId: input.workspaceId,
            queryRewriteEnabled: true,
            semanticRewriteInstructions: "",
            lexicalRewriteInstructions: "",
            suggestedQuestionsEnabled: false,
            suggestedQuestionsCount: 0,
            rerankEnabled: false,
            vectorTopK: 20,
            similarityThreshold: 0.1,
            rerankTopK: 5,
            citationDisplayEnabled: true,
            customInstruction: "",
            metadataRules: [],
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          contextWindow: { selectedMessages: [], truncated: false, selectionReason: "full-history" },
        },
      },
      interpretation: { startedAt: Date.now(), durationMs: 1, result: {} },
    };
  },
  async runInterpreted() {
    throw new Error("a direct turn never retrieves");
  },
  async runWithoutRetrieval(input: { query: string }) {
    return {
      rewrittenQuery: input.query,
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
      diagnostics: { retrievalSkipped: true },
      trace: { startedAt: new Date().toISOString(), stages: [], links: [] },
    };
  },
};

/** What a test sees of a turn: its events in order, plus the order of chunks against persistence. */
interface Observed {
  order: string[];
  events: ChatStreamEvent[];
}

/**
 * A ChatService over in-memory stores that records, into `order`, when an assistant
 * message is written and when routine state is saved, so a test can read chunks against
 * persistence.
 */
const chatService = async (input: {
  routineProvider: ChatRoutineProvider;
  chatGateway: ChatGateway;
  order: string[];
  activeRoutine?: RoutineState | null;
  failAssistantMessage?: Error;
}) => {
  // The built-in contact routine runs only for an agent that takes contact requests somewhere.
  const agent = await new InMemoryAgentRepository().create("workspace-1", {
    name: "Support",
    contactRequestsEnabled: true,
    contactRequestDelivery: { recipientEmails: ["owner@example.com"], webhook: null },
  });
  const conversationRepository = new InMemoryConversationRepository();
  const conversation = await conversationRepository.create({ workspaceId: "workspace-1", agentId: agent.id });
  pinExistingConversationsToPublishedRevisions(conversationRepository);
  const messageRepository = new InMemoryMessageRepository();
  const createMessage = messageRepository.create.bind(messageRepository);
  messageRepository.create = vi.fn(async (message: Parameters<InMemoryMessageRepository["create"]>[0]) => {
    if (message.role === "assistant") {
      input.order.push("persist");
      if (input.failAssistantMessage) {
        throw input.failAssistantMessage;
      }
    }
    return createMessage(message);
  });
  const routineStore = {
    loadActive: vi.fn(async () => input.activeRoutine ?? null),
    save: vi.fn(async (state: RoutineState) => {
      input.order.push(`save:${state.status}`);
    }),
    clear: vi.fn(async () => {
      input.order.push("clear");
    }),
  };
  const reservation = { commit: vi.fn(async () => {}), release: vi.fn(async () => {}) };
  const usageLimitPolicy: NonNullable<ChatServiceOptions["usageLimitPolicy"]> = {
    reserveAnswer: vi.fn(async () => reservation),
    reserveDocument: vi.fn(async () => reservation),
    reserveIndexedStorage: vi.fn(async () => reservation),
    reserveMonthlyIndexedContent: vi.fn(async () => reservation),
  };
  const metrics = { incrementCounter: vi.fn(), observeHistogram: vi.fn() };
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const service = new ChatService({
    conversationRepository,
    messageRepository,
    retrievalTurn: new RetrievalTurnController(directAnswerPipeline as never),
    chatGateway: input.chatGateway,
    auditService: createAuditService(),
    turnRuntime: buildChatTurnRuntime({
      chatGateway: input.chatGateway,
      fallbackReplyComposer,
      skillOutcomeCapabilities: { supportsGroundedAnswer: () => false },
      metrics,
    }),
    usageLimitPolicy,
    agentService: { resolve: vi.fn(async () => agent) },
    agentRevisionRuntimeResolver: publishedRevisionResolverFixture(),
    turnRouter: {
      async classify() {
        return { route: "direct" as const, framing: { isIdentityQuestion: false } };
      },
    },
    conversationEngine: createConversationEngine(),
    routineStore,
    routineProvider: input.routineProvider,
    actionOutbox: { enqueue: vi.fn(async () => ({ id: "action-1", duplicate: false })) },
    logger,
  });
  /** An existing conversation with this agent, for turns that must share one. */
  const existingConversationId = conversation.id;
  return { service, messageRepository, routineStore, reservation, metrics, logger, existingConversationId };
};

const request = (query: string, extra: { conversationId?: string; signal?: AbortSignal } = {}) => ({
  workspaceId: "workspace-1",
  query,
  stream: true,
  ...extra,
});

/** Drains a turn, recording each chunk into `order`; resolves with the error the turn failed with, if any. */
const drainTurn = async (stream: AsyncIterable<ChatStreamEvent>, observed: Observed): Promise<unknown> => {
  try {
    for await (const event of stream) {
      observed.events.push(event);
      if (event.type === "chunk") {
        observed.order.push(`chunk:${event.text}`);
      }
    }
    return undefined;
  } catch (error) {
    return error;
  }
};

const chunkText = (events: ChatStreamEvent[]): string =>
  events.flatMap((event) => event.type === "chunk" ? [event.text] : []).join("");

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

// --- The production routine stack: the built-in contact routine, the default runner, selector and
// step renderer, all generating through the turn's RoutineChatModelGateway. ---

const candidateRevision: AgentRevision = {
  id: "44444444-4444-4444-8444-444444444444",
  snapshot: { customInstruction: "", directives: [], routines: [], contextVariableEnablements: [] },
  sourceDraftGeneration: 1,
  sourceBasePublishedRevisionId: null,
  createdAt: new Date(0),
  publishedAt: null,
  publishedVersion: null,
};

const builtInRegistrations = (): RoutineRegistration[] => {
  const registry = createApplicationExtensionRegistry();
  new ApplicationModuleCoordinator({ logger: { error: () => {} }, registry }).apply([
    createContactRoutineApplicationModule(),
  ]);
  return registry.routineRegistrations;
};

const contactRoutineProvider = (): ChatRoutineProvider => createRoutineTurnProvider({
  agentSkillRepository: { listByAgent: vi.fn(async () => []) },
  capabilityPolicy: new DefaultAllowCapabilityPolicy(),
  clusteringEmbeddings: {
    embedForClustering: vi.fn(async ({ texts }: { texts: string[] }) => ({ vectors: texts.map(() => [1, 0]) })),
  } as never,
  embeddingModelForWorkspace: vi.fn(async () => "test-embedding"),
  logger: { debug: vi.fn(), warn: vi.fn() },
  publishedRoutineSource: createPublishedRoutineRegistrationSource({
    listActiveByAgent: vi.fn(async () => []),
    listVersionsByAgent: vi.fn(async () => []),
    findPinnedById: vi.fn(async () => null),
    findById: vi.fn(async () => null),
  }, { revisionReader: { findRevision: vi.fn(async () => candidateRevision) } }),
  routineDefinitionRepository: {
    searchActivationTriggerEmbeddings: vi.fn(async () => ({ matches: [], noVectorRoutineIds: [] })),
  },
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

type PromptKind = "activation" | "selector" | "reply:ask_email" | "direct" | "other";

const promptKind = (systemPrompt: string): PromptKind => {
  if (systemPrompt.includes("Rank whether the latest user message wants to start any registered routine")) return "activation";
  if (systemPrompt.includes("You are guiding a user through a structured, multi-step routine")) return "selector";
  if (systemPrompt.includes("email address where they can be reached")) return "reply:ask_email";
  return "other";
};

/**
 * A model that starts the contact routine and keeps it on its email step. Whole calls answer
 * the routine's activation ranking and step selection; `streamReply` writes each streamed
 * step reply (and the direct answer of a turn the routine yields). Every call is recorded
 * as `<kind> <via> <usage attempt>`.
 */
const contactModel = (input: {
  streamReply: (call: { kind: PromptKind; input: ChatGatewayInput; attempt: number }) => AsyncIterable<string>;
  selector?: string;
}) => {
  const calls: string[] = [];
  let streamAttempts = 0;
  const chatGateway: ChatGateway = {
    async answer(gatewayInput) {
      const kind = promptKind(gatewayInput.systemPrompt ?? "");
      calls.push(`${kind} answer ${gatewayInput.usageContext.attemptKey}`);
      if (kind === "activation") {
        return JSON.stringify({ matches: [{ routineId: contactRoutineDefinition.id, confidence: 0.95, variables: {} }] });
      }
      if (kind === "selector") {
        return input.selector ?? JSON.stringify({ claimsAuthority: false, condition: null, offTopic: false, variables: {} });
      }
      return "A whole answer.";
    },
    async *streamAnswer(gatewayInput) {
      const kind = promptKind(gatewayInput.systemPrompt ?? "");
      calls.push(`${kind} stream ${gatewayInput.usageContext.attemptKey}`);
      streamAttempts += 1;
      yield* input.streamReply({ kind, input: gatewayInput, attempt: streamAttempts });
    },
  };
  return { chatGateway, calls };
};

// --- A routine runner double that claims the turn with given effects and reply. ---

const claimingRoutine = (claims: Array<{ effects?: Partial<ConversationRoutineRunEffects>; reply: PendingRenderableTurn }>) => {
  const claim = vi.fn<NonNullable<ConversationRoutineRunner["claim"]>>();
  for (const entry of claims) {
    claim.mockImplementationOnce(async ({ state }) => ({
      kind: "claimed" as const,
      effects: {
        nextState: { ...state, path: ["ask_email"], status: "active" as const },
        trace: {
          routineId: state.routineId,
          startStepId: "ask_email",
          landedStepId: "ask_email",
          capturedSlotKeys: [],
          filledSlotKeys: [],
          steps: [],
        },
        ...entry.effects,
      },
      reply: entry.reply,
    }));
  }
  const runner: ConversationRoutineRunner = {
    resume: async () => {
      throw new Error("the claim is the routine's whole walk");
    },
    claim,
  };
  const routineProvider: ChatRoutineProvider = {
    forTurn: async () => ({
      activator: { activate: async () => ({ kind: "activate" as const, routineId: "contact.request" }) },
      runner,
    }),
  };
  return { routineProvider, claim };
};

/** A reply that streams `deltas` (awaiting `hold` before the delta at `holdAt`) and renders their join whole. */
const streamingReply = (deltas: string[], options: { hold?: Promise<void>; holdAt?: number; failAfter?: Error } = {}) => {
  const turn: RenderableTurn = { answer: deltas.join("") };
  const reply = {
    render: vi.fn(async () => turn),
    stream: vi.fn(async function* (): AsyncGenerator<string, RenderableTurn> {
      for (const [index, delta] of deltas.entries()) {
        if (options.hold && index === (options.holdAt ?? 0)) {
          await options.hold;
        }
        yield delta;
      }
      if (options.failAfter) {
        throw options.failAfter;
      }
      return turn;
    }),
  };
  return reply;
};

const unusedGateway: ChatGateway = {
  async answer() {
    return "A direct answer.";
  },
  async *streamAnswer() {
    yield "A direct answer.";
  },
};

// --- A routine whose first step is a skill step, run on the production runner, step renderer,
// skill dispatcher and grounded answer renderer: `lookup` (the skill) → `answer` (a chat step). ---

const skillStepRoutine = (skillName: string): Routine => ({
  id: "skill_then_answer",
  rootStepId: "lookup",
  steps: [
    { id: "lookup", kind: "skill", skillName },
    { id: "answer", kind: "chat", action: "Answer the visitor's question from what the lookup found, then ask if anything else is needed." },
    { id: "done", kind: "terminal", action: "Say goodbye.", metadata: { terminalKind: "complete" } },
  ],
  transitions: [
    { from: "lookup", to: "answer", condition: "always" },
    { from: "answer", to: "done", condition: "the visitor is done" },
  ],
});

const stagedRetrieval = (): RetrievalPipelineResult =>
  ({
    rewrittenQuery: "opening hours",
    contexts: [{
      documentId: "doc_1",
      chunkId: "chunk_1",
      title: "Opening hours",
      content: "The studio is open nine to five on weekdays.",
      metadata: {},
    }],
    systemPrompt: "retrieval system prompt",
    prompt: "Result 1 (Opening hours): The studio is open nine to five on weekdays.",
    citations: [],
    responseIdentity: null,
    responseSettings: {
      citationDisplayEnabled: true,
      suggestedQuestionsEnabled: false,
      suggestedQuestionsCount: 0,
      responseLanguagePolicy: "match_user_question",
    },
    diagnostics: {},
    trace: { traceId: "retrieval-trace", startedAt: "2026-10-08T00:00:00.000Z", stages: [], links: [] },
  } as unknown as RetrievalPipelineResult);

/** A routine provider over the production routine stack, its skill step run by `executor` on `skill`'s execution. */
const skillStepRoutineProvider = (skill: SkillDefinition, executor: SkillExecutorPort): ChatRoutineProvider => {
  const registry = new SkillExecutorRegistry();
  registry.register({ ...(skill.execution as { kind: "internal"; adapter: string }), executor });
  const routine = skillStepRoutine(skill.name);
  return {
    forTurn: async ({ modelGateway, groundedAnswerRenderer }) => ({
      routines: [routine],
      activator: { activate: async () => ({ kind: "activate" as const, routineId: routine.id }) },
      runner: new DefaultRoutineRunner(
        [routine],
        { select: async () => ({ nextStepId: "answer" }) },
        new RoutineStepRenderer(modelGateway, { groundedAnswerRenderer }),
        new RoutineSkillExecutorDispatcher(new StaticRoutineSkillResolver([skill]), registry),
      ),
    }),
  };
};

const groundedEnvelope = (answer: string): string => JSON.stringify({
  coverage: "answered_sufficient_evidence",
  requestFocus: "the studio's opening hours",
  outcome: "answer",
  answer,
  v: 2,
  claims: [[1]],
  suggestions: [],
  grounding: "grounded",
});

describe("ChatService delivers a routine reply after a skill step by what the skill did", () => {
  it("streams a retrieval-fed step's grounded answer behind the citation gate, before persisting it", async () => {
    const output = groundedEnvelope("The studio is open nine to five on weekdays[[1]]. Anything else?");
    const anchorAt = output.indexOf("[[1]]");
    const deltas = [output.slice(0, 60), output.slice(60, anchorAt - 5), output.slice(anchorAt - 5, anchorAt + 2), output.slice(anchorAt + 2, anchorAt + 20), output.slice(anchorAt + 20)];
    let modelDeltasProduced = 0;
    const order: string[] = [];
    const chatGateway: ChatGateway = {
      async answer() {
        throw new Error("the grounded step streams; nothing completes whole");
      },
      async *streamAnswer() {
        for (const delta of deltas) {
          modelDeltasProduced += 1;
          yield delta;
        }
      },
    };
    const lookup = vi.fn(async () => ({
      disposition: "settled" as const,
      outcome: {
        status: "context_ready",
        outputs: { has_context: true },
        metadata: { __retrievalResult: stagedRetrieval() },
      } as unknown as SkillOutcome,
    }));
    const observed: Observed = { order, events: [] };
    const harness = await chatService({
      routineProvider: skillStepRoutineProvider(retrievalContextSkillDefinition, { dispatch: lookup }),
      chatGateway,
      order,
    });
    const shownAfterDeltas: number[] = [];

    for await (const event of harness.service.streamAnswer(request("When are you open?"))) {
      observed.events.push(event);
      if (event.type === "chunk") {
        shownAfterDeltas.push(modelDeltasProduced);
        order.push(`chunk:${event.text}`);
      }
    }

    expect(lookup).toHaveBeenCalledOnce();
    const shown = chunkText(observed.events);
    expect(shown).toBe("The studio is open nine to five on weekdays. Anything else?");
    expect(shown).not.toContain("coverage");
    // Held until the model wrote the `[[1]]` citation in the third delta.
    expect(Math.min(...shownAfterDeltas)).toBeGreaterThanOrEqual(3);
    expect(order.indexOf("persist")).toBeGreaterThan(order.findIndex((entry) => entry.startsWith("chunk:")));
    expect(order.slice(-2)).toEqual(["persist", "save:active"]);
    const done = observed.events.find((event) => event.type === "done");
    const routineStage = done?.type === "done"
      ? done.turnTrace?.spine.stages.find((stage) => stage.kind === "routine_activate")
      : undefined;
    expect(routineStage?.outputs).toMatchObject({ replyDelivery: "stream" });
  });

  it("keeps the reply whole after a webhook skill step ran, showing it only once the turn is saved", async () => {
    const order: string[] = [];
    const chatGateway: ChatGateway = {
      async answer() {
        return "Done — we've sent that over. Anything else?";
      },
      async *streamAnswer() {
        yield "Done — we've sent that over. Anything else?";
      },
    };
    const callWebhook = vi.fn(async () => ({
      disposition: "settled" as const,
      outcome: { status: "completed", outputs: { delivered: true } } as unknown as SkillOutcome,
    }));
    const webhookSkill = {
      name: "crm_webhook",
      execution: { kind: "internal", adapter: WEBHOOK_SKILLS_ADAPTER, enqueue: false },
      requiredCapabilities: [],
      owner: "platform",
    } as unknown as SkillDefinition;
    const observed: Observed = { order, events: [] };
    const harness = await chatService({
      routineProvider: skillStepRoutineProvider(webhookSkill, { dispatch: callWebhook }),
      chatGateway,
      order,
    });

    const error = await drainTurn(harness.service.streamAnswer(request("Please pass this to the CRM")), observed);

    expect(error).toBeUndefined();
    expect(callWebhook).toHaveBeenCalledOnce();
    expect(order).toEqual(["persist", "save:active", "chunk:Done — we've sent that over. Anything else?"]);
    const done = observed.events.find((event) => event.type === "done");
    const routineStage = done?.type === "done"
      ? done.turnTrace?.spine.stages.find((stage) => stage.kind === "routine_activate")
      : undefined;
    expect(routineStage?.outputs).toMatchObject({ replyDelivery: "whole" });
  });
});

describe("ChatService streams a routine reply that reports no completed action", () => {
  it("streams a slot ask while the model is still writing it, then persists the message and the step", async () => {
    const modelStillWriting = deferred();
    let modelFinished = false;
    const model = contactModel({
      async *streamReply({ kind }) {
        if (kind !== "reply:ask_email") {
          throw new Error(`unexpected streamed call: ${kind}`);
        }
        yield "Which email ";
        await modelStillWriting.promise;
        yield "can someone reach you at?";
        modelFinished = true;
      },
    });
    const observed: Observed = { order: [], events: [] };
    const harness = await chatService({ routineProvider: contactRoutineProvider(), chatGateway: model.chatGateway, order: observed.order });

    const events = harness.service.streamAnswer(request("How do I contact a human?"))[Symbol.asyncIterator]();
    let first = await events.next();
    while (!first.done && first.value.type !== "chunk") {
      observed.events.push(first.value);
      first = await events.next();
    }

    // Trailing whitespace waits for the text after it, as the whole reply's trim would drop it.
    expect(first.value).toEqual({ type: "chunk", text: "Which email" });
    expect(modelFinished).toBe(false);
    expect(observed.order).toEqual([]);
    expect(harness.reservation.commit).not.toHaveBeenCalled();

    modelStillWriting.resolve();
    observed.order.push("chunk:Which email");
    const error = await drainTurn({ [Symbol.asyncIterator]: () => events }, observed);

    expect(error).toBeUndefined();
    expect(observed.order).toEqual([
      "chunk:Which email",
      "chunk: can someone reach you at?",
      "persist",
      "save:active",
    ]);
    expect(harness.routineStore.save).toHaveBeenCalledWith(expect.objectContaining({
      routineId: contactRoutineDefinition.id,
      status: "active",
      attempts: { ask_email: 1 },
    }));
    const done = observed.events.find((event) => event.type === "done");
    expect(done).toMatchObject({ answer: "Which email can someone reach you at?" });
    const conversationId = done?.type === "done" ? done.conversationId : "";
    const messages = await harness.messageRepository.listByConversationId("workspace-1", conversationId);
    expect(messages.map((message) => [message.role, message.content])).toEqual([
      ["user", "How do I contact a human?"],
      ["assistant", "Which email can someone reach you at?"],
    ]);
    expect(harness.reservation.commit).toHaveBeenCalledOnce();
    expect(model.calls).toEqual([
      "activation answer routine_turn:routine_activation",
      "selector answer routine_turn:2",
      "reply:ask_email stream routine_turn:3",
    ]);
    expect(harness.metrics.observeHistogram).toHaveBeenCalledWith(
      "chat_stream_first_answer_chunk_latency_ms",
      expect.objectContaining({ labels: { route: "routine", delivery_mode: "live" } }),
    );
    const routineStage = done?.type === "done"
      ? done.turnTrace?.spine.stages.find((stage) => stage.kind === "routine_activate")
      : undefined;
    expect(routineStage?.outputs).toMatchObject({ replyDelivery: "stream" });
  });

  it("retries a blank streamed reply once; the visitor sees only the retry, and both attempts are metered", async () => {
    const model = contactModel({
      async *streamReply({ attempt }) {
        if (attempt === 1) {
          yield " ";
          yield "\n";
          return;
        }
        yield "Which email can someone reach you at?";
      },
    });
    const observed: Observed = { order: [], events: [] };
    const harness = await chatService({ routineProvider: contactRoutineProvider(), chatGateway: model.chatGateway, order: observed.order });

    const error = await drainTurn(harness.service.streamAnswer(request("How do I contact a human?")), observed);

    expect(error).toBeUndefined();
    expect(observed.events.filter((event) => event.type === "chunk")).toEqual([
      { type: "chunk", text: "Which email can someone reach you at?" },
    ]);
    expect(model.calls).toEqual([
      "activation answer routine_turn:routine_activation",
      "selector answer routine_turn:2",
      "reply:ask_email stream routine_turn:3",
      "reply:ask_email stream routine_turn:3:blank_retry",
    ]);
    expect(observed.events.find((event) => event.type === "done")).toMatchObject({ answer: "Which email can someone reach you at?" });
  });

  it("never writes the reply of a turn the routine yields, and streams the answer that takes the turn instead", async () => {
    const model = contactModel({
      selector: JSON.stringify({ claimsAuthority: false, condition: null, offTopic: true, variables: {} }),
      async *streamReply({ kind }) {
        if (kind === "reply:ask_email") {
          throw new Error("a yielded routine never writes its reply");
        }
        yield "Our opening hours are nine to five.";
      },
    });
    const observed: Observed = { order: [], events: [] };
    const harness = await chatService({
      routineProvider: contactRoutineProvider(),
      chatGateway: model.chatGateway,
      order: observed.order,
      activeRoutine: {
        sessionId: "s",
        routineId: contactRoutineDefinition.id,
        executionId: "exec-1",
        path: ["ask_email"],
        variables: {},
        status: "active",
      },
    });

    const error = await drainTurn(harness.service.streamAnswer(request("When are you open?")), observed);

    expect(error).toBeUndefined();
    expect(chunkText(observed.events)).toBe("Our opening hours are nine to five.");
    expect(model.calls.filter((call) => call.startsWith("reply:"))).toEqual([]);
    expect(harness.routineStore.save).not.toHaveBeenCalled();
  });

  const durableEndings: Array<{ name: string; effects: Partial<ConversationRoutineRunEffects> }> = [
    {
      name: "an action",
      effects: { actions: [{ type: "contact.send", payload: { email: "a@b.c" } }] },
    },
    {
      name: "a completion",
      effects: { nextState: null, terminal: { kind: "complete", stepId: "done" } },
    },
    {
      name: "a completion that notifies operators",
      effects: {
        nextState: null,
        terminal: { kind: "complete", stepId: "done", operatorNotice: { subject: "New request" } },
      },
    },
    {
      name: "a hand-off",
      effects: { nextState: null, terminal: { kind: "handoff", stepId: "escalate" } },
    },
    {
      name: "a visitor stuck past the re-ask limit",
      effects: { nextState: null, terminal: { kind: "stuck", stepId: "ask_email" } },
    },
    {
      name: "an approval gate",
      effects: {
        nextState: {
          sessionId: "s",
          routineId: "contact.request",
          path: ["approve"],
          variables: {},
          status: "suspended",
        },
        awaitingDecision: { stepId: "approve", options: [{ id: "approve", label: "Approve" }], captureKey: "decision" },
      },
    },
    {
      // The skill already acted (an email sent) while the routine walked to its next chat step.
      name: "a skill step that ran before a next chat step",
      effects: { skillsWithExternalEffects: ["customer_email.send"] },
    },
  ];

  for (const { name, effects } of durableEndings) {
    it(`shows the reply of ${name} only once the turn is persisted, and never when persisting fails`, async () => {
      const committed: Observed = { order: [], events: [] };
      const okReply = streamingReply(["Your request ", "is in."]);
      const ok = claimingRoutine([{ effects, reply: okReply }]);
      const okHarness = await chatService({ routineProvider: ok.routineProvider, chatGateway: unusedGateway, order: committed.order });

      expect(await drainTurn(okHarness.service.streamAnswer(request("contact me")), committed)).toBeUndefined();

      expect(okReply.stream).not.toHaveBeenCalled();
      expect(okReply.render).toHaveBeenCalledOnce();
      expect(committed.order[0]).toBe("persist");
      expect(committed.order.at(-1)).toBe("chunk:Your request is in.");
      expect(okHarness.metrics.observeHistogram).toHaveBeenCalledWith(
        "chat_stream_first_answer_chunk_latency_ms",
        expect.objectContaining({ labels: { route: "routine", delivery_mode: "committed" } }),
      );
      const done = committed.events.find((event) => event.type === "done");
      const routineStage = done?.type === "done"
        ? done.turnTrace?.spine.stages.find((stage) => stage.kind === "routine_activate")
        : undefined;
      expect(routineStage?.outputs).toMatchObject({ replyDelivery: "whole" });

      const failed: Observed = { order: [], events: [] };
      const failingReply = streamingReply(["Your request ", "is in."]);
      const failing = claimingRoutine([{ effects, reply: failingReply }]);
      const failingHarness = await chatService({
        routineProvider: failing.routineProvider,
        chatGateway: unusedGateway,
        order: failed.order,
        failAssistantMessage: new Error("assistant message write failed"),
      });

      const error = await drainTurn(failingHarness.service.streamAnswer(request("contact me")), failed);

      expect(error).toBeInstanceOf(Error);
      expect(failed.events.filter((event) => event.type === "chunk")).toEqual([]);
      expect(failingReply.stream).not.toHaveBeenCalled();
      expect(failingHarness.routineStore.save).not.toHaveBeenCalled();
      expect(failingHarness.routineStore.clear).not.toHaveBeenCalled();
      expect(failingHarness.logger.warn).not.toHaveBeenCalledWith(
        expect.objectContaining({ event: "routine_reply_persist_failed_after_stream" }),
        expect.anything(),
      );
    });
  }

  it("keeps the routine on its step when persisting fails after the reply was shown, and says so without its content", async () => {
    const observed: Observed = { order: [], events: [] };
    const { routineProvider } = claimingRoutine([{ reply: streamingReply(["Which email ", "can we use?"]) }]);
    const harness = await chatService({
      routineProvider,
      chatGateway: unusedGateway,
      order: observed.order,
      failAssistantMessage: new Error("assistant message write failed"),
    });

    const error = await drainTurn(harness.service.streamAnswer(request("contact me")), observed);

    expect(error).toBeInstanceOf(Error);
    expect(chunkText(observed.events)).toBe("Which email can we use?");
    expect(observed.events.some((event) => event.type === "done")).toBe(false);
    expect(observed.order).toEqual(["chunk:Which email ", "chunk:can we use?", "persist"]);
    expect(harness.routineStore.save).not.toHaveBeenCalled();
    expect(harness.reservation.commit).not.toHaveBeenCalled();
    expect(harness.reservation.release).toHaveBeenCalled();
    const conversationId = observed.events.find((event) => event.type === "conversation");
    expect(harness.logger.warn).toHaveBeenCalledWith(
      {
        event: "routine_reply_persist_failed_after_stream",
        workspaceId: "workspace-1",
        conversationId: conversationId?.type === "conversation" ? conversationId.conversationId : undefined,
        routineId: "contact.request",
        stepId: "ask_email",
        errorType: "Error",
      },
      expect.any(String),
    );
    expect(JSON.stringify(harness.logger.warn.mock.calls)).not.toContain("Which email");
    expect(harness.metrics.incrementCounter).toHaveBeenCalledWith(
      "chat_stream_persist_failures_total",
      expect.objectContaining({ labels: { route: "routine" } }),
    );
  });

  it("persists nothing when the model fails partway through the reply", async () => {
    const observed: Observed = { order: [], events: [] };
    const { routineProvider } = claimingRoutine([{
      reply: streamingReply(["Which email "], { failAfter: new Error("provider_reset") }),
    }]);
    const harness = await chatService({ routineProvider, chatGateway: unusedGateway, order: observed.order });

    const error = await drainTurn(harness.service.streamAnswer(request("contact me")), observed);

    expect(error).toBeInstanceOf(Error);
    expect(observed.order).toEqual(["chunk:Which email "]);
    expect(harness.routineStore.save).not.toHaveBeenCalled();
    expect(harness.reservation.commit).not.toHaveBeenCalled();
    expect(harness.reservation.release).toHaveBeenCalled();
    expect(harness.metrics.incrementCounter).not.toHaveBeenCalledWith("chat_stream_persist_failures_total", expect.anything());
  });

  it("keeps streaming a visitor who disconnects mid-reply to its end, and persists the message and the step", async () => {
    const visitorLeft = deferred();
    const model = contactModel({
      async *streamReply() {
        yield "Which email ";
        await visitorLeft.promise;
        yield "can someone reach you at?";
      },
    });
    const observed: Observed = { order: [], events: [] };
    const harness = await chatService({ routineProvider: contactRoutineProvider(), chatGateway: model.chatGateway, order: observed.order });
    const writes: string[] = [];
    let closeConnection: (() => void) | undefined;
    const response = {
      headersSent: false,
      destroyed: false,
      writableEnded: false,
      on(event: string, handler: () => void) {
        if (event === "close") {
          closeConnection = handler;
        }
      },
      status() {
        return this;
      },
      setHeader() {},
      flushHeaders() {
        this.headersSent = true;
      },
      write(chunk: string) {
        writes.push(chunk);
        if (chunk.includes("Which email")) {
          // The visitor closes the tab right after the first words arrive.
          this.destroyed = true;
          closeConnection?.();
          visitorLeft.resolve();
        }
      },
      end() {
        this.writableEnded = true;
      },
    };

    await sendChatSse(response as never, harness.service.streamAnswer(request("How do I contact a human?")));

    expect(writes.join("")).toContain("Which email");
    expect(writes.join("")).not.toContain("can someone reach you at?");
    expect(observed.order).toEqual(["persist", "save:active"]);
    expect(harness.reservation.commit).toHaveBeenCalledOnce();
    const persisted = vi.mocked(harness.messageRepository.create).mock.calls
      .map(([message]) => message)
      .filter((message) => message.role === "assistant");
    expect(persisted.map((message) => message.content)).toEqual(["Which email can someone reach you at?"]);
  });

  it("aborts the model once the disconnected visitor's turn passes its ceiling, persisting nothing", async () => {
    const providerSignals: AbortSignal[] = [];
    const model = contactModel({
      async *streamReply({ input }) {
        providerSignals.push(input.signal!);
        yield "Which email ";
        // A provider request that runs until its signal aborts, like a fetch would.
        await new Promise((_resolve, reject) => {
          const signal = input.signal!;
          if (signal.aborted) {
            reject(signal.reason as Error);
            return;
          }
          signal.addEventListener("abort", () => reject(signal.reason as Error), { once: true });
        });
      },
    });
    const observed: Observed = { order: [], events: [] };
    const harness = await chatService({ routineProvider: contactRoutineProvider(), chatGateway: model.chatGateway, order: observed.order });
    const disconnectCeiling = new AbortController();

    const events = harness.service.streamAnswer(request("How do I contact a human?", { signal: disconnectCeiling.signal }))[Symbol.asyncIterator]();
    let next = await events.next();
    while (!next.done && next.value.type !== "chunk") {
      next = await events.next();
    }
    expect(next.value).toEqual({ type: "chunk", text: "Which email" });
    disconnectCeiling.abort();

    await expect(events.next()).rejects.toBeInstanceOf(ChatTurnDisconnectAbortError);
    expect(providerSignals[0]?.aborted).toBe(true);
    expect(observed.order).toEqual([]);
    expect(harness.reservation.commit).not.toHaveBeenCalled();
    expect(harness.reservation.release).toHaveBeenCalled();
  });

  it("persists nothing when the ceiling cancels the turn while a reply that ignores the abort finishes streaming", async () => {
    const providerStillWriting = deferred();
    const reply = streamingReply(["Which email ", "can we use?"], { hold: providerStillWriting.promise, holdAt: 1 });
    const { routineProvider } = claimingRoutine([{ reply }]);
    const observed: Observed = { order: [], events: [] };
    const harness = await chatService({ routineProvider, chatGateway: unusedGateway, order: observed.order });
    const disconnectCeiling = new AbortController();

    const events = harness.service.streamAnswer(request("contact me", { signal: disconnectCeiling.signal }))[Symbol.asyncIterator]();
    let next = await events.next();
    while (!next.done && next.value.type !== "chunk") {
      next = await events.next();
    }
    expect(next.value).toEqual({ type: "chunk", text: "Which email " });
    // The ceiling fires; the provider ignores the abort and finishes its buffered text.
    disconnectCeiling.abort();
    providerStillWriting.resolve();

    const error = await drainTurn({ [Symbol.asyncIterator]: () => events }, observed);

    expect(error).toBeInstanceOf(ChatTurnDisconnectAbortError);
    expect(observed.order.filter((entry) => !entry.startsWith("chunk:"))).toEqual([]);
    expect(harness.routineStore.save).not.toHaveBeenCalled();
    expect(harness.reservation.commit).not.toHaveBeenCalled();
    expect(harness.reservation.release).toHaveBeenCalled();
    expect(observed.events.some((event) => event.type === "done")).toBe(false);
  });

  it("is superseded by a newer message while no reply has been shown", async () => {
    const firstHeld = deferred();
    const firstReply = streamingReply(["Stale ", "reply"], { hold: firstHeld.promise });
    const { routineProvider } = claimingRoutine([
      { reply: firstReply },
      { reply: streamingReply(["Latest ", "reply"]) },
    ]);
    const first: Observed = { order: [], events: [] };
    const second: Observed = { order: [], events: [] };
    const harness = await chatService({ routineProvider, chatGateway: unusedGateway, order: first.order });
    const conversation = { id: harness.existingConversationId };

    const firstTurn = drainTurn(harness.service.streamAnswer(request("contact me", { conversationId: conversation.id })), first);
    await vi.waitFor(() => expect(firstReply.stream).toHaveBeenCalled());
    const secondTurn = drainTurn(harness.service.streamAnswer(request("actually, call me", { conversationId: conversation.id })), second);
    firstHeld.resolve();

    expect(await firstTurn).toBeUndefined();
    expect(await secondTurn).toBeUndefined();
    expect(first.events.filter((event) => event.type === "chunk")).toEqual([]);
    expect(first.events.at(-1)).toMatchObject({ type: "cancelled", reason: "superseded" });
    expect(chunkText(second.events)).toBe("Latest reply");
  });

  it("makes a newer message wait once the reply has started showing", async () => {
    const firstHeld = deferred();
    const { routineProvider } = claimingRoutine([
      { reply: streamingReply(["Which email ", "can we use?"], { hold: firstHeld.promise, holdAt: 1 }) },
      { reply: streamingReply(["Thanks."]) },
    ]);
    const first: Observed = { order: [], events: [] };
    const second: Observed = { order: [], events: [] };
    const harness = await chatService({ routineProvider, chatGateway: unusedGateway, order: first.order });
    const conversation = { id: harness.existingConversationId };

    const firstEvents = harness.service.streamAnswer(request("contact me", { conversationId: conversation.id }))[Symbol.asyncIterator]();
    let next = await firstEvents.next();
    while (!next.done && next.value.type !== "chunk") {
      first.events.push(next.value);
      next = await firstEvents.next();
    }
    expect(next.value).toEqual({ type: "chunk", text: "Which email " });
    const secondTurn = drainTurn(harness.service.streamAnswer(request("a@b.c", { conversationId: conversation.id })), second);
    await tick();

    expect(second.events).toEqual([]);
    firstHeld.resolve();
    expect(await drainTurn({ [Symbol.asyncIterator]: () => firstEvents }, first)).toBeUndefined();
    expect(await secondTurn).toBeUndefined();

    expect(first.events.some((event) => event.type === "cancelled")).toBe(false);
    expect(first.events.at(-1)).toMatchObject({ type: "done", answer: "Which email can we use?" });
    expect(chunkText(second.events)).toBe("Thanks.");
  });

  it("renders the reply whole on the non-streaming path, as before", async () => {
    const reply = streamingReply(["Which email ", "can we use?"]);
    const { routineProvider } = claimingRoutine([{ reply }]);
    const observed: Observed = { order: [], events: [] };
    const harness = await chatService({ routineProvider, chatGateway: unusedGateway, order: observed.order });

    const response = await harness.service.answer({ ...request("contact me"), stream: false });

    expect(response.answer).toBe("Which email can we use?");
    expect(reply.render).toHaveBeenCalledOnce();
    expect(reply.stream).not.toHaveBeenCalled();
    expect(observed.order).toEqual(["persist", "save:active"]);
    const routineStage = response.turnTrace?.spine.stages.find((stage) => stage.kind === "routine_activate");
    expect(routineStage?.outputs).not.toHaveProperty("replyDelivery");
  });
});
