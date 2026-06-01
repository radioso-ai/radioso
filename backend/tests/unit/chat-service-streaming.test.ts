import { describe, expect, it } from "vitest";

import type { ConversationEngine } from "@radioso/conversation-contract";
import { createConversationEngine } from "@radioso/conversation-engine";
import {
  BlankChatAnswerError,
  ChatService,
  type ChatGateway,
  type ChatServiceOptions,
  type ChatStreamEvent,
} from "../../src/modules/chat/services/chatService.js";
import {
  buildChatTurnRuntime,
  type ChatTurnRuntimeDependencies,
} from "../../src/modules/chat/services/chatTurnRuntime.js";
import { RetrievalTurnController } from "../../src/modules/chat/services/retrievalTurnDispatch.js";
import type { SkillOutcomeCapabilityProvider } from "../../src/modules/chat/services/chatAnswerPresenter.js";
import type { ChatIntakeProviderPort } from "../../src/modules/chat/services/chatIntakeProvider.js";
import {
  MissingFallbackReplyComposer,
  type FallbackReplyComposer,
} from "../../src/modules/chat/services/fallbackReplyComposer.js";
import { SUGGESTIONS_SENTINEL } from "../../src/modules/chat/services/groundedAnswerEnvelope.js";
import {
  createAuditService,
  InMemoryAuditEventRepository,
  InMemoryConversationRepository,
  InMemoryMessageRepository,
} from "../support/fakes.js";

const envelope = (answer: string, suggestions: unknown[]): string =>
  `${answer}\n${SUGGESTIONS_SENTINEL}\n${JSON.stringify(suggestions)}`;

const groundingEnvelope = (
  answer: string,
  grounding: "grounded" | "degraded",
  suggestions: unknown[] = [],
): string => `${answer}\n${SUGGESTIONS_SENTINEL}\n${JSON.stringify({ grounding, suggestions })}`;

const groundedSkillCapabilities: SkillOutcomeCapabilityProvider = {
  supportsGroundedAnswer: () => true,
};

const fallbackReplyComposer: FallbackReplyComposer = {
  async composeNoContext() {
    return "I couldn't find supporting material for that in your workspace documents. If you'd like, try asking about a topic that's covered there.";
  },
};

// Bridges the legacy positional construction used across these streaming tests to
// the options-object ChatService API. Production wiring (dependencyBuilders) passes
// options directly and injects the runtime; here we assemble it from the same
// gateway / fallback / capabilities the positional form supplied.
const makeChatService = (
  conversationRepository: ChatServiceOptions["conversationRepository"],
  messageRepository: ChatServiceOptions["messageRepository"],
  retrievalTurn: ChatServiceOptions["retrievalTurn"],
  chatGateway: ChatServiceOptions["chatGateway"],
  auditService: ChatServiceOptions["auditService"],
  fallbackReplyComposer: ChatTurnRuntimeDependencies["fallbackReplyComposer"] = new MissingFallbackReplyComposer(),
  productAnalyticsService?: ChatServiceOptions["productAnalyticsService"],
  workspaceRepository?: ChatServiceOptions["workspaceRepository"],
  usageLimitPolicy?: ChatServiceOptions["usageLimitPolicy"],
  agentService?: ChatServiceOptions["agentService"],
  chatIntakeProvider?: ChatServiceOptions["chatIntakeProvider"],
  chatActionSuggestionService?: ChatTurnRuntimeDependencies["chatActionSuggestionService"],
  skillOutcomeCapabilities: ChatTurnRuntimeDependencies["skillOutcomeCapabilities"] = {
    supportsGroundedAnswer: () => false,
  },
  directiveSteering?: ChatServiceOptions["directiveSteering"],
  selectionStrategy?: ChatServiceOptions["selectionStrategy"],
  conversationEngine?: ChatServiceOptions["conversationEngine"],
): ChatService =>
  new ChatService({
    conversationRepository,
    messageRepository,
    retrievalTurn,
    chatGateway,
    auditService,
    turnRuntime: buildChatTurnRuntime({
      chatGateway,
      fallbackReplyComposer,
      chatActionSuggestionService,
      skillOutcomeCapabilities,
    }),
    productAnalyticsService,
    workspaceRepository,
    usageLimitPolicy,
    agentService,
    chatIntakeProvider,
    directiveSteering,
    selectionStrategy,
    conversationEngine,
  });

const asChatActivityPipeline = (pipeline: Record<string, unknown>) => {
  if (
    typeof pipeline.interpret === "function"
    && typeof pipeline.runInterpreted === "function"
    && typeof pipeline.runWithoutRetrieval === "function"
  ) {
    return pipeline;
  }

  if (typeof pipeline.run !== "function") {
    return pipeline;
  }

  return {
    ...pipeline,
    async interpret(input: {
      workspaceId: string;
      query: string;
      history: unknown[];
      responseIdentity?: unknown;
      responseBehaviorEnabled?: boolean;
      metadataFilter?: Record<string, unknown>;
    }) {
      return {
        request: input,
        traceStartedAtMs: Date.now(),
        context: {
          startedAt: Date.now(),
          durationMs: 1,
          result: {
            request: input,
            settings: {
              workspaceId: input.workspaceId,
              queryRewriteEnabled: true,
              semanticRewriteInstructions: "",
              lexicalRewriteInstructions: "",
              suggestedQuestionsEnabled: true,
              suggestedQuestionsCount: 3,
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
            contextWindow: {
              selectedMessages: [],
              truncated: false,
              selectionReason: "full-history",
            },
          },
        },
        interpretation: {
          startedAt: Date.now(),
          durationMs: 1,
          result: {
            responseIntent: "retrieval",
          },
        },
      };
    },
    async runInterpreted(interpretation: { request: unknown }) {
      return (pipeline.run as (input: unknown) => unknown | Promise<unknown>)(interpretation.request);
    },
    async runWithoutRetrieval() {
      throw new Error("runWithoutRetrieval should not be used for retrieval turns");
    },
  };
};

describe("chat service streaming", () => {
  const createIntentRoutedNoContextPipeline = (input: {
    query: string;
    responseIntent: "social_only" | "assistant_identity";
    responseIdentity?: {
      name: string;
    };
    customInstruction?: string;
  }) => ({
    async run() {
      throw new Error("run should not be used when intent routing is available");
    },
    async interpret() {
      return {
        request: {
          workspaceId: "workspace-1",
          query: input.query,
          history: [],
          responseIdentity: input.responseIdentity ?? null,
        },
        traceStartedAtMs: Date.now(),
        context: {
          startedAt: Date.now(),
          durationMs: 1,
          result: {
            request: {
              workspaceId: "workspace-1",
              query: input.query,
              history: [],
              responseIdentity: input.responseIdentity ?? null,
            },
            settings: {
              workspaceId: "workspace-1",
              queryRewriteEnabled: true,
              semanticRewriteInstructions: "",
              lexicalRewriteInstructions: "",
              suggestedQuestionsEnabled: true,
              suggestedQuestionsCount: 3,
              rerankEnabled: false,
              vectorTopK: 20,
              similarityThreshold: 0.1,
              rerankTopK: 5,
              citationDisplayEnabled: true,
              customInstruction: input.customInstruction ?? "",
              metadataRules: [],
              createdAt: new Date(),
              updatedAt: new Date(),
            },
            contextWindow: {
              selectedMessages: [],
              truncated: false,
              selectionReason: "full-history",
            },
          },
        },
        interpretation: {
          startedAt: Date.now(),
          durationMs: 1,
          result: {
            responseIntent: input.responseIntent,
          },
        },
      };
    },
    async runInterpreted() {
      throw new Error("runInterpreted should not be used for non-retrieval turns");
    },
    async runWithoutRetrieval() {
      return {
        rewrittenQuery: input.query,
        contexts: [],
        prompt: "",
        citations: [],
        responseIdentity: input.responseIdentity ?? null,
        responseSettings: {
          citationDisplayEnabled: true,
          suggestedQuestionsEnabled: true,
          suggestedQuestionsCount: 3,
          customInstruction: input.customInstruction ?? "",
          responseLanguagePolicy: "match_user_question",
        },
        diagnostics: {
          rewriteStatus: "applied",
          rerankStatus: "skipped",
          originalCandidateCount: 0,
          rewrittenCandidateCount: 0,
          lexicalCandidateCount: 0,
          normalizedCandidateCount: 0,
          finalContextCount: 0,
          candidateFallbackApplied: false,
          fallbackApplied: false,
          responseIntent: input.responseIntent,
          retrievalSkipped: true,
          intentConfidence: 0.9,
          intentFallbackApplied: false,
          parsedQuery: {
            originalQuery: input.query,
            semanticQuery: input.query,
            lexicalQuery: input.query,
            constraints: [],
          },
          triggerAnalysis: {
            status: "skipped_non_retrieval",
            consideredRules: [],
            matchedRuleIds: [],
            unmatchedRuleIds: [],
            matchCount: 0,
            matcherVersion: "non_retrieval",
          },
        },
        trace: {
          traceId: `trace-${input.responseIntent}`,
          startedAt: new Date().toISOString(),
          stages: [
            { stageId: "diagnostics", kind: "diagnostics", label: "Diagnostics", status: "skipped" },
          ],
          links: [],
        },
      };
    },
  });

  it("handles skill intake before retrieval execution", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    let interpretCalls = 0;
    const retrievalPipeline = {
      async interpret() {
        interpretCalls += 1;
        throw new Error("retrieval unavailable");
      },
      async runInterpreted() {
        throw new Error("runInterpreted should not be used for intake turns");
      },
      async runWithoutRetrieval() {
        throw new Error("runWithoutRetrieval should not be used for intake turns");
      },
    };
    const intakeProvider: ChatIntakeProviderPort = {
      async handle() {
        return {
          skillName: "human_contact.request",
          status: "completed",
          answer: "Received.",
          activitySummary: {
            outcome: "request_queued",
            status: "completed",
          } as never,
          activityTrace: {
            traceId: "contact-trace",
            startedAt: new Date().toISOString(),
            stages: [],
            links: [],
            summary: {
              outcome: "request_queued",
              status: "completed",
            },
          } as never,
        };
      },
    };
    const service = makeChatService(
      conversationRepository,
      messageRepository,
      new RetrievalTurnController(asChatActivityPipeline(retrievalPipeline) as never),
      {
        async answer() {
          return "Normal answer.";
        },
        async *streamAnswer() {
          yield "Normal answer.";
        },
      },
      auditService,
      fallbackReplyComposer,
      undefined,
      undefined,
      undefined,
      undefined,
      intakeProvider,
    );

    const response = await service.answer({
      workspaceId: "workspace-1",
      query: "Please contact me at alex@example.com.",
      stream: false,
    });

    expect(response.answer).toBe("Received.");
    expect(interpretCalls).toBe(0);
    const messages = await messageRepository.listByConversationId("workspace-1", response.conversationId);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  it("applies LLM-emitted skill_receipt overrides onto the captured receipt and strips the tag", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = {
      async interpret() { throw new Error("unused"); },
      async runInterpreted() { throw new Error("unused"); },
      async runWithoutRetrieval() { throw new Error("unused"); },
    };
    const intakeProvider: ChatIntakeProviderPort = {
      async handle() {
        return {
          skillName: "human_contact.request",
          status: "completed",
          answer: "<skill_chip>Contatto richiesto</skill_chip><skill_receipt>{\"status\":\"Inviato\",\"fields\":{\"email\":\"indirizzo email\"}}</skill_receipt>Ho ricevuto la tua richiesta.",
          activitySummary: { outcome: "request_queued", status: "completed" } as never,
          activityTrace: {
            traceId: "contact-trace",
            startedAt: new Date().toISOString(),
            stages: [],
            links: [],
            summary: { outcome: "request_queued", status: "completed" },
          } as never,
          receipt: {
            fields: [
              { name: "email", displayName: "email address", value: "alex@example.com" },
            ],
          },
        };
      },
    };
    const service = makeChatService(
      conversationRepository,
      messageRepository,
      new RetrievalTurnController(asChatActivityPipeline(retrievalPipeline) as never),
      {
        async answer() { return "Normal."; },
        async *streamAnswer() { yield "Normal."; },
      },
      auditService,
      fallbackReplyComposer,
      undefined,
      undefined,
      undefined,
      undefined,
      intakeProvider,
    );

    const events: ChatStreamEvent[] = [];
    for await (const event of service.streamAnswer({
      workspaceId: "workspace-1",
      query: "alex@example.com",
      stream: true,
    })) {
      events.push(event);
    }

    const skillEvent = events.find((event) => event.type === "skill");
    if (skillEvent && skillEvent.type === "skill") {
      expect(skillEvent.localizedTitle).toBe("Contatto richiesto");
      expect(skillEvent.receipt?.statusLabel).toBe("Inviato");
      expect(skillEvent.receipt?.fields[0]?.displayName).toBe("indirizzo email");
      expect(skillEvent.receipt?.fields[0]?.value).toBe("alex@example.com");
    }

    const chunkEvent = events.find((event) => event.type === "chunk");
    expect(chunkEvent && chunkEvent.type === "chunk" && chunkEvent.text).toBe(
      "Ho ricevuto la tua richiesta.",
    );
  });

  it("falls back to the original receipt fields when the LLM omits or malforms the receipt tag", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = {
      async interpret() { throw new Error("unused"); },
      async runInterpreted() { throw new Error("unused"); },
      async runWithoutRetrieval() { throw new Error("unused"); },
    };
    const intakeProvider: ChatIntakeProviderPort = {
      async handle() {
        return {
          skillName: "human_contact.request",
          status: "completed",
          answer: "<skill_chip>Contact us</skill_chip><skill_receipt>{not json}</skill_receipt>Your request was received.",
          activitySummary: { outcome: "request_queued", status: "completed" } as never,
          activityTrace: {
            traceId: "contact-trace",
            startedAt: new Date().toISOString(),
            stages: [],
            links: [],
            summary: { outcome: "request_queued", status: "completed" },
          } as never,
          receipt: {
            fields: [
              { name: "email", displayName: "email address", value: "alex@example.com" },
            ],
          },
        };
      },
    };
    const service = makeChatService(
      conversationRepository,
      messageRepository,
      new RetrievalTurnController(asChatActivityPipeline(retrievalPipeline) as never),
      {
        async answer() { return "Normal."; },
        async *streamAnswer() { yield "Normal."; },
      },
      auditService,
      fallbackReplyComposer,
      undefined,
      undefined,
      undefined,
      undefined,
      intakeProvider,
    );

    const events: ChatStreamEvent[] = [];
    for await (const event of service.streamAnswer({
      workspaceId: "workspace-1",
      query: "alex@example.com",
      stream: true,
    })) {
      events.push(event);
    }

    const skillEvent = events.find((event) => event.type === "skill");
    if (skillEvent && skillEvent.type === "skill") {
      expect(skillEvent.receipt?.statusLabel).toBeUndefined();
      expect(skillEvent.receipt?.fields[0]?.displayName).toBe("email address");
    }

    const chunkEvent = events.find((event) => event.type === "chunk");
    expect(chunkEvent && chunkEvent.type === "chunk" && chunkEvent.text).toBe(
      "Your request was received.",
    );
  });

  it("emits a skill stream event and strips the skill_chip tag from the chunk and persisted answer", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = {
      async interpret() {
        throw new Error("retrieval should not be reached for intake turns");
      },
      async runInterpreted() {
        throw new Error("runInterpreted should not be used for intake turns");
      },
      async runWithoutRetrieval() {
        throw new Error("runWithoutRetrieval should not be used for intake turns");
      },
    };
    const intakeProvider: ChatIntakeProviderPort = {
      async handle() {
        return {
          skillName: "human_contact.request",
          status: "completed",
          display: {
            icon: "handshake",
            title: "Contact us",
          },
          answer: "<skill_chip>Связаться</skill_chip>Ваш запрос получен.",
          activitySummary: {
            outcome: "request_queued",
            status: "completed",
          } as never,
          activityTrace: {
            traceId: "contact-trace",
            startedAt: new Date().toISOString(),
            stages: [],
            links: [],
            summary: {
              outcome: "request_queued",
              status: "completed",
            },
          } as never,
          receipt: {
            fields: [
              {
                name: "email",
                displayName: "email address",
                value: "alex@example.com",
              },
            ],
          },
        };
      },
    };
    const service = makeChatService(
      conversationRepository,
      messageRepository,
      new RetrievalTurnController(asChatActivityPipeline(retrievalPipeline) as never),
      {
        async answer() {
          return "Normal answer.";
        },
        async *streamAnswer() {
          yield "Normal answer.";
        },
      },
      auditService,
      fallbackReplyComposer,
      undefined,
      undefined,
      undefined,
      undefined,
      intakeProvider,
    );

    const events: ChatStreamEvent[] = [];
    for await (const event of service.streamAnswer({
      workspaceId: "workspace-1",
      query: "alex@example.com",
      stream: true,
    })) {
      events.push(event);
    }

    const skillEvent = events.find((event) => event.type === "skill");
    expect(skillEvent).toBeDefined();
    if (skillEvent && skillEvent.type === "skill") {
      expect(skillEvent.localizedTitle).toBe("Связаться");
      expect(skillEvent.phase).toBe("completed");
      expect(skillEvent.skillName).toBe("human_contact.request");
      expect(skillEvent.display).toEqual({
        icon: "handshake",
        title: "Contact us",
      });
      expect(skillEvent.receipt?.fields[0]?.value).toBe("alex@example.com");
    }

    const chunkEvent = events.find((event) => event.type === "chunk");
    expect(chunkEvent && chunkEvent.type === "chunk" && chunkEvent.text).toBe(
      "Ваш запрос получен.",
    );

    const doneEvent = events.find((event) => event.type === "done");
    expect(doneEvent && doneEvent.type === "done" && doneEvent.skill?.phase).toBe(
      "completed",
    );
    expect(doneEvent && doneEvent.type === "done" && doneEvent.answer).toBe(
      "Ваш запрос получен.",
    );

    const messages = await messageRepository.listByConversationId(
      "workspace-1",
      (doneEvent as { conversationId: string }).conversationId,
    );
    const assistantMessage = messages.find((message) => message.role === "assistant");
    expect(assistantMessage?.content).toBe("Ваш запрос получен.");
  });

  it("continues the chat turn when a skill intake provider throws", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const chatGateway: ChatGateway = {
      async answer() {
        return "Normal answer.";
      },
      async *streamAnswer() {
        yield "Normal answer.";
      },
    };
    const failingIntakeProvider: ChatIntakeProviderPort = {
      async handle() {
        throw new Error("intake unavailable");
      },
    };
    const service = makeChatService(
      conversationRepository,
      messageRepository,
      new RetrievalTurnController(asChatActivityPipeline(createIntentRoutedNoContextPipeline({
        query: "I need help",
        responseIntent: "social_only",
      })) as never),
      chatGateway,
      auditService,
      fallbackReplyComposer,
      undefined,
      undefined,
      undefined,
      undefined,
      failingIntakeProvider,
    );

    const response = await service.answer({
      workspaceId: "workspace-1",
      query: "I need help",
      stream: false,
    });

    expect(response.answer).toBe("Normal answer.");
    const messages = await messageRepository.listByConversationId("workspace-1", response.conversationId);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(auditService.events).toContainEqual(
      expect.objectContaining({
        eventType: "chat.skill_intake",
        eventStatus: "failure",
        metadata: expect.objectContaining({
          errorMessage: "intake unavailable",
          conversationId: response.conversationId,
        }),
      }),
    );
  });

  it("can render a non-streaming answer through an injected conversation engine", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const chatGateway: ChatGateway = {
      async answer() {
        return "Normal answer.";
      },
      async *streamAnswer() {
        yield "Normal answer.";
      },
    };
    let processedSessionId: string | null = null;
    const conversationEngine: ConversationEngine = {
      async processTurn(input) {
        processedSessionId = input.sessionId;
        const history = await input.stores.loadHistory({ sessionId: input.sessionId });
        const turn = {
          agent: input.agent,
          sessionId: input.sessionId,
          inputEvent: input.inputEvent,
          history,
          stagedContext: [],
          steering: [],
        };
        const decision = await input.selector.select({
          turn,
          skills: input.skills,
          directives: await input.directiveMatcher.match({ turn, directives: input.directives }),
        });
        const selected = decision.selected[0];
        const skill = input.skills.find((candidate) => candidate.name === selected?.skillName);
        if (!selected || !skill) {
          throw new Error("expected a selected skill");
        }
        const outcome = await input.dispatcher.dispatch({ skill, turn, selected });
        const response = await input.composer.compose({ turn, outcomes: [outcome], decision });
        return {
          sessionId: input.sessionId,
          events: [],
          decision,
          outcomes: [outcome],
          response,
          trace: {
            traceId: "test-engine",
            startedAt: new Date().toISOString(),
            stages: [],
          },
        };
      },
      async *processTurnStream() {
        throw new Error("processTurnStream should not be used in this test");
      },
    };
    const service = makeChatService(
      conversationRepository,
      messageRepository,
      new RetrievalTurnController(asChatActivityPipeline(createIntentRoutedNoContextPipeline({
        query: "I need help",
        responseIntent: "social_only",
      })) as never),
      chatGateway,
      auditService,
      fallbackReplyComposer,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      conversationEngine,
    );

    const response = await service.answer({
      workspaceId: "workspace-1",
      query: "I need help",
      stream: false,
    });

    expect(processedSessionId).toBe(response.conversationId);
    expect(response.answer).toBe("Normal answer.");
    const messages = await messageRepository.listByConversationId("workspace-1", response.conversationId);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  it("records the conversation engine trace in chat.answer audit metadata when the engine selects and dispatches", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const chatGateway: ChatGateway = {
      async answer() {
        return "Normal answer.";
      },
      async *streamAnswer() {
        yield "Normal answer.";
      },
    };
    const service = makeChatService(
      conversationRepository,
      messageRepository,
      new RetrievalTurnController(asChatActivityPipeline(createIntentRoutedNoContextPipeline({
        query: "I need help",
        responseIntent: "social_only",
      })) as never),
      chatGateway,
      auditService,
      fallbackReplyComposer,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      // Real engine: drives selection + dispatch and produces the turn trace.
      createConversationEngine(),
    );

    const response = await service.answer({
      workspaceId: "workspace-1",
      query: "I need help",
      stream: false,
    });

    const answerEvent = auditService.events.find(
      (event) => event.eventType === "chat.answer" && event.eventStatus === "success",
    );
    expect(answerEvent).toBeDefined();
    const metadata = answerEvent?.metadata as {
      activityTrace?: unknown;
      conversationEngine?: {
        trace?: { stages?: Array<{ kind: string; outputs?: Record<string, unknown> }> };
      };
    };
    // The retrieval-derived activity trace stays unchanged (behavior-preserving).
    expect(metadata.activityTrace).toBeDefined();
    const engineTrace = metadata.conversationEngine?.trace;
    expect(engineTrace).toBeDefined();
    const selectionStage = engineTrace?.stages?.find((stage) => stage.kind === "skill_selection");
    // The engine routes on the turn's intent: a social_only turn selects the social
    // answer skill (not retrieval) — selection is genuinely capability-based now.
    expect(selectionStage?.outputs?.selectedSkills).toContain("social_only.answer");
    expect(engineTrace?.stages?.some((stage) => stage.kind === "skill_dispatch")).toBe(true);
    expect(response.answer).toBe("Normal answer.");
  });

  it("records the conversation engine trace for streamed terminal answers when the engine is wired", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const chatGateway: ChatGateway = {
      async answer() {
        return "Normal answer.";
      },
      async *streamAnswer() {
        yield "Normal";
        yield " answer.";
      },
    };
    const service = makeChatService(
      conversationRepository,
      messageRepository,
      new RetrievalTurnController(asChatActivityPipeline(createIntentRoutedNoContextPipeline({
        query: "I need help",
        responseIntent: "social_only",
      })) as never),
      chatGateway,
      auditService,
      fallbackReplyComposer,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      createConversationEngine(),
    );

    const events: ChatStreamEvent[] = [];
    for await (const event of service.streamAnswer({
      workspaceId: "workspace-1",
      query: "I need help",
      stream: true,
    })) {
      events.push(event);
    }

    expect(events.filter((event) => event.type === "chunk").map((event) => event.text).join("")).toBe("Normal answer.");
    const doneEvent = events.find((event): event is Extract<ChatStreamEvent, { type: "done" }> => event.type === "done");
    expect(doneEvent?.answer).toBe("Normal answer.");
    const answerEvent = auditService.events.find(
      (event) => event.eventType === "chat.answer" && event.eventStatus === "success",
    );
    const metadata = answerEvent?.metadata as {
      conversationEngine?: {
        trace?: { stages?: Array<{ kind: string; outputs?: Record<string, unknown> }> };
      };
    };
    const engineTrace = metadata.conversationEngine?.trace;
    expect(engineTrace).toBeDefined();
    expect(engineTrace?.stages?.find((stage) => stage.kind === "skill_selection")?.outputs?.selectedSkills)
      .toContain("social_only.answer");
    expect(engineTrace?.stages?.some((stage) => stage.kind === "compose")).toBe(true);
  });

  it("omits conversation engine audit metadata when no engine is wired", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const chatGateway: ChatGateway = {
      async answer() {
        return "Normal answer.";
      },
      async *streamAnswer() {
        yield "Normal answer.";
      },
    };
    const service = makeChatService(
      conversationRepository,
      messageRepository,
      new RetrievalTurnController(asChatActivityPipeline(createIntentRoutedNoContextPipeline({
        query: "I need help",
        responseIntent: "social_only",
      })) as never),
      chatGateway,
      auditService,
      fallbackReplyComposer,
    );

    await service.answer({
      workspaceId: "workspace-1",
      query: "I need help",
      stream: false,
    });

    const answerEvent = auditService.events.find(
      (event) => event.eventType === "chat.answer" && event.eventStatus === "success",
    );
    expect(answerEvent).toBeDefined();
    expect((answerEvent?.metadata as { conversationEngine?: unknown }).conversationEngine).toBeUndefined();
  });

  it("persists the normalized assistant answer only after the stream completes", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = {
      async run() {
        return {
          rewrittenQuery: "what does this page do",
          contexts: [
            {
              chunkId: "chunk-1",
              documentId: "doc-1",
              title: "Intro",
              content: "full answer",
            },
          ],
          prompt: "prompt text",
          citations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Intro" }],
          diagnostics: {
            rewriteStatus: "skipped",
            rerankStatus: "skipped",
            originalCandidateCount: 1,
            rewrittenCandidateCount: 0,
            lexicalCandidateCount: 1,
            normalizedCandidateCount: 1,
            finalContextCount: 1,
            candidateFallbackApplied: false,
            fallbackApplied: false,
            parsedQuery: {
              semanticQuery: "page do",
              lexicalQuery: "page do",
              constraints: [],
            },
          },
          responseSettings: {
            citationDisplayEnabled: true,
          },
        };
      },
    } as const;
    const chatGateway: ChatGateway = {
      async answer() {
        return "full answer[[1]]";
      },
      async *streamAnswer() {
        yield "full answer[[";
        yield "1]]";
      },
    };
    const service = makeChatService(
      conversationRepository,
      messageRepository,
      new RetrievalTurnController(asChatActivityPipeline(retrievalPipeline) as never),
      chatGateway,
      auditService,
      fallbackReplyComposer,
    );

    const events: ChatStreamEvent[] = [];

    for await (const event of service.streamAnswer({
      workspaceId: "workspace-1",
      query: "What does this page do?",
      stream: true,
    })) {
      events.push(event);

      if (event.type === "chunk") {
        expect(event.text).not.toContain("[[");
        const [conversationId] = conversationRepository.items.keys();
        const persisted = await messageRepository.listByConversationId("workspace-1", conversationId!);
        expect(persisted.map((message) => message.role)).toEqual(["user"]);
      }
    }

    expect(events[0]).toEqual({ type: "conversation", conversationId: expect.any(String) });
    expect(events[1]).toEqual({ type: "chunk", text: "full answer" });
    expect(events[2]).toEqual({
      type: "done",
      conversationId: expect.any(String),
      agentId: "workspace-1",
      agentName: "",
      assistantMessageId: expect.any(String),
      route: {
        type: "retrieval",
        reason: "evidence_required",
      },
      answer: "full answer",
      citations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Intro" }],
      answerSegments: [{ text: "full answer", citationIndices: [0] }],
      suggestions: undefined,
      activitySummary: expect.objectContaining({
        parsedQuery: expect.objectContaining({
          originalQuery: "page do",
          semanticQuery: "page do",
          lexicalQuery: "page do",
          constraintSummary: [],
        }),
        candidateCounts: {
          semantic: 1,
          lexical: 1,
          merged: 1,
          final: 1,
        },
        fallbackApplied: false,
        rerankStatus: "skipped",
        rewrite: expect.objectContaining({
          status: "skipped",
          eligible: false,
          ran: false,
        }),
      }),
      activityTrace: expect.objectContaining({
        stages: expect.arrayContaining([
          expect.objectContaining({
            stageId: "answer",
            kind: "answer_outcome",
            status: "applied",
          }),
        ]),
      }),
    });

    const [conversationId] = conversationRepository.items.keys();
    const persisted = await messageRepository.listByConversationId("workspace-1", conversationId!);
    expect(persisted.map((message) => ({ role: message.role, content: message.content }))).toEqual([
      { role: "user", content: "What does this page do?" },
      { role: "assistant", content: "full answer" },
    ]);
    expect(auditService.events[0]?.metadata?.workflow).toBe("chat.turn");
    expect(auditService.events[0]?.metadata?.executionClass).toBe("interactive_synchronous");
    expect(auditService.events[0]?.metadata?.rewriteContinuityState).toEqual({
      activeSubject: "Intro",
      relatedEntities: [],
      groundedTitles: ["Intro"],
    });
  });

  it("streams prose without citation tokens and attaches citations in the final event", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = {
      async run() {
        return {
          rewrittenQuery: "how should i start meditating",
          contexts: [
            {
              chunkId: "chunk-1",
              documentId: "doc-1",
              title: "Meditation Tips",
              content: "Keep meditation practice short and simple. Begin with a few minutes each day instead of starting with a long session.",
            },
          ],
          prompt: "prompt text",
          citations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Meditation Tips" }],
          diagnostics: {
            rewriteStatus: "skipped",
            rerankStatus: "skipped",
            originalCandidateCount: 1,
            rewrittenCandidateCount: 0,
            lexicalCandidateCount: 1,
            normalizedCandidateCount: 1,
            finalContextCount: 1,
            candidateFallbackApplied: false,
            fallbackApplied: false,
            parsedQuery: {
              semanticQuery: "start meditating",
              lexicalQuery: "start meditating",
              constraints: [],
            },
          },
          responseSettings: {
            citationDisplayEnabled: true,
          },
        };
      },
    } as const;
    const chatGateway: ChatGateway = {
      async answer() {
        return "Keep meditation practice short and simple. Begin with a few minutes each day.";
      },
      async *streamAnswer() {
        yield "Keep meditation practice short ";
        yield "and simple. Begin with a few minutes each day.";
      },
    };
    const service = makeChatService(
      conversationRepository,
      messageRepository,
      new RetrievalTurnController(asChatActivityPipeline(retrievalPipeline) as never),
      chatGateway,
      auditService,
      fallbackReplyComposer,
    );

    const events: ChatStreamEvent[] = [];

    for await (const event of service.streamAnswer({
      workspaceId: "workspace-1",
      query: "How should I start meditating?",
      stream: true,
    })) {
      events.push(event);
      if (event.type === "chunk") {
        expect(event.text).not.toContain("[[");
        expect(event.text).not.toContain("]]");
      }
    }

    const streamedText = events
      .filter((event): event is Extract<ChatStreamEvent, { type: "chunk" }> => event.type === "chunk")
      .map((event) => event.text)
      .join("");
    const done = events.find((event): event is Extract<ChatStreamEvent, { type: "done" }> => event.type === "done");

    expect(streamedText).toBe("Keep meditation practice short and simple. Begin with a few minutes each day.");
    expect(done).toEqual(expect.objectContaining({
      answer: "Keep meditation practice short and simple. Begin with a few minutes each day.",
      citations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Meditation Tips" }],
      answerSegments: [
        {
          text: "Keep meditation practice short and simple. Begin with a few minutes each day.",
          citationIndices: [0],
        },
      ],
    }));
  });

  it("streams grounded prose token-by-token after the first citation instead of batching per citation", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const fullAnswer =
      "The first supporting claim is fully grounded in the provided source material. "
      + "This following sentence continues the explanation without its own citation marker. "
      + "And a third sentence streams in as the model keeps generating more tokens. "
      + "Finally a closing sentence wraps things up neatly.";
    const retrievalPipeline = {
      async run() {
        return {
          rewrittenQuery: "explain the grounded topic",
          contexts: [
            {
              chunkId: "chunk-1",
              documentId: "doc-1",
              title: "Source",
              content: fullAnswer,
            },
          ],
          prompt: "prompt text",
          citations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Source" }],
          diagnostics: {
            rewriteStatus: "skipped",
            rerankStatus: "skipped",
            originalCandidateCount: 1,
            rewrittenCandidateCount: 0,
            lexicalCandidateCount: 1,
            normalizedCandidateCount: 1,
            finalContextCount: 1,
            candidateFallbackApplied: false,
            fallbackApplied: false,
            parsedQuery: {
              semanticQuery: "grounded topic",
              lexicalQuery: "grounded topic",
              constraints: [],
            },
          },
          responseSettings: {
            citationDisplayEnabled: true,
          },
        };
      },
    } as const;
    // Only the first sentence carries a citation; the rest is un-cited prose that
    // is part of the final grounded answer. The provider emits each sentence as a
    // separate streaming chunk.
    const chatGateway: ChatGateway = {
      async answer() {
        return fullAnswer;
      },
      async *streamAnswer() {
        yield "The first supporting claim is fully grounded in the provided source material[[1]]. ";
        yield "This following sentence continues the explanation without its own citation marker. ";
        yield "And a third sentence streams in as the model keeps generating more tokens. ";
        yield "Finally a closing sentence wraps things up neatly.";
        yield `\n${SUGGESTIONS_SENTINEL}\n[]`;
      },
    };
    const service = makeChatService(
      conversationRepository,
      messageRepository,
      new RetrievalTurnController(asChatActivityPipeline(retrievalPipeline) as never),
      chatGateway,
      auditService,
      fallbackReplyComposer,
    );

    const chunks: string[] = [];
    let doneAnswer = "";
    for await (const event of service.streamAnswer({
      workspaceId: "workspace-1",
      query: "Explain the grounded topic.",
      stream: true,
    })) {
      if (event.type === "chunk") {
        expect(event.text).not.toContain("[[");
        expect(event.text).not.toContain("]]");
        chunks.push(event.text);
      } else if (event.type === "done") {
        doneAnswer = event.answer ?? "";
      }
    }

    // Per-citation batching emitted only two body chunks (the cited prefix, then
    // every later sentence dumped together at finalize). Latching on the first
    // citation streams the trailing prose incrementally instead.
    expect(chunks.length).toBeGreaterThanOrEqual(4);
    expect(chunks.join("").trim()).toBe(doneAnswer);
    expect(doneAnswer).toBe(fullAnswer);
  });

  it("emits grounded answer chunks before the provider stream finishes", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const releaseTail = (() => {
      let resolve!: () => void;
      const promise = new Promise<void>((complete) => {
        resolve = complete;
      });
      return { promise, resolve };
    })();
    const retrievalPipeline = {
      async run() {
        return {
          rewrittenQuery: "how should i start meditating",
          contexts: [
            {
              chunkId: "chunk-1",
              documentId: "doc-1",
              title: "Meditation Tips",
              content: "Keep meditation practice short and simple. Begin with a few minutes each day.",
            },
          ],
          prompt: "prompt text",
          citations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Meditation Tips" }],
          diagnostics: {
            rewriteStatus: "skipped",
            rerankStatus: "skipped",
            originalCandidateCount: 1,
            rewrittenCandidateCount: 0,
            lexicalCandidateCount: 1,
            normalizedCandidateCount: 1,
            finalContextCount: 1,
            candidateFallbackApplied: false,
            fallbackApplied: false,
            parsedQuery: {
              semanticQuery: "start meditating",
              lexicalQuery: "start meditating",
              constraints: [],
            },
          },
          responseSettings: {
            citationDisplayEnabled: true,
          },
        };
      },
    } as const;
    const chatGateway: ChatGateway = {
      async answer() {
        return "Keep meditation practice short and simple. Begin with a few minutes each day[[1]]. This cited sentence has arrived and can stream now.";
      },
      async *streamAnswer() {
        yield "Keep meditation practice short and simple. Begin with a few minutes each day[[1]]. This cited sentence has arrived and can stream now.";
        await releaseTail.promise;
        yield `\n${SUGGESTIONS_SENTINEL}\n[]`;
      },
    };
    const service = makeChatService(
      conversationRepository,
      messageRepository,
      new RetrievalTurnController(asChatActivityPipeline(retrievalPipeline) as never),
      chatGateway,
      auditService,
      fallbackReplyComposer,
    );

    const iterator = service.streamAnswer({
      workspaceId: "workspace-1",
      query: "How should I start meditating?",
      stream: true,
    })[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: "conversation", conversationId: expect.any(String) },
    });

    const nextEvent = iterator.next();
    const firstAnswerEvent = await Promise.race([
      nextEvent,
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 20)),
    ]);

    try {
      expect(firstAnswerEvent).not.toBe("timeout");
      expect(firstAnswerEvent).toEqual({
        done: false,
        value: expect.objectContaining({
          type: "chunk",
          text: expect.stringContaining("Keep meditation practice short"),
        }),
      });
    } finally {
      releaseTail.resolve();
      await nextEvent.catch(() => undefined);
      await iterator.return?.();
    }
  });

  it("streams clean prose and attaches final citations", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = {
      async run() {
        return {
          rewrittenQuery: "how should i start meditating",
          contexts: [
            {
              chunkId: "chunk-1",
              documentId: "doc-1",
              title: "Meditation Tips",
              content: "Keep meditation practice short and simple. Begin with a few minutes each day instead of starting with a long session.",
            },
          ],
          prompt: "prompt text",
          citations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Meditation Tips" }],
          diagnostics: {
            rewriteStatus: "skipped",
            rerankStatus: "skipped",
            originalCandidateCount: 1,
            rewrittenCandidateCount: 0,
            lexicalCandidateCount: 1,
            normalizedCandidateCount: 1,
            finalContextCount: 1,
            candidateFallbackApplied: false,
            fallbackApplied: false,
            parsedQuery: {
              semanticQuery: "start meditating",
              lexicalQuery: "start meditating",
              constraints: [],
            },
          },
          responseSettings: {
            citationDisplayEnabled: true,
          },
        };
      },
    } as const;
    const chatGateway: ChatGateway = {
      async answer() {
        return "Keep meditation practice short and simple. Begin with a few minutes each day.";
      },
      async *streamAnswer() {
        yield "Keep meditation practice short ";
        yield "and simple. Begin with a few minutes each day.";
      },
    };
    const service = makeChatService(
      conversationRepository,
      messageRepository,
      new RetrievalTurnController(asChatActivityPipeline(retrievalPipeline) as never),
      chatGateway,
      auditService,
      fallbackReplyComposer,
    );

    const events: ChatStreamEvent[] = [];

    for await (const event of service.streamAnswer({
      workspaceId: "workspace-1",
      query: "How should I start meditating?",
      stream: true,
    })) {
      events.push(event);
      if (event.type === "chunk") {
        expect(event.text).not.toContain("[[");
        expect(event.text).not.toContain("]]");
      }
    }

    const streamedText = events
      .filter((event): event is Extract<ChatStreamEvent, { type: "chunk" }> => event.type === "chunk")
      .map((event) => event.text)
      .join("");
    const done = events.find((event): event is Extract<ChatStreamEvent, { type: "done" }> => event.type === "done");

    expect(streamedText).toBe("Keep meditation practice short and simple. Begin with a few minutes each day.");
    expect(done).toEqual(expect.objectContaining({
      answer: "Keep meditation practice short and simple. Begin with a few minutes each day.",
      citations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Meditation Tips" }],
      answerSegments: [
        {
          text: "Keep meditation practice short and simple. Begin with a few minutes each day.",
          citationIndices: [0],
        },
      ],
    }));
  });

  it("does not stream unsupported grounded drafts when the final answer is a grounded miss", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = {
      async run() {
        return {
          rewrittenQuery: "what does this page do",
          contexts: [
            {
              chunkId: "chunk-1",
              documentId: "doc-1",
              title: "Guide",
              content: "The page explains testing and parsing content for users.",
            },
          ],
          prompt: "prompt text",
          citations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Guide" }],
          diagnostics: {
            rewriteStatus: "skipped",
            rerankStatus: "skipped",
            originalCandidateCount: 1,
            rewrittenCandidateCount: 0,
            lexicalCandidateCount: 1,
            normalizedCandidateCount: 1,
            finalContextCount: 1,
            candidateFallbackApplied: false,
            fallbackApplied: false,
            parsedQuery: {
              semanticQuery: "page do",
              lexicalQuery: "page do",
              constraints: [],
            },
          },
          responseSettings: {
            citationDisplayEnabled: true,
          },
        };
      },
    } as const;
    const unsupportedDraft = "It also offers 24/7 phone support and a discount code.";
    const chatGateway: ChatGateway = {
      async answer() {
        return unsupportedDraft;
      },
      async *streamAnswer() {
        yield "It also offers 24/7 phone ";
        yield "support and a discount code.";
      },
    };
    const service = makeChatService(
      conversationRepository,
      messageRepository,
      new RetrievalTurnController(asChatActivityPipeline(retrievalPipeline) as never),
      chatGateway,
      auditService,
      fallbackReplyComposer,
    );

    const events: ChatStreamEvent[] = [];

    for await (const event of service.streamAnswer({
      workspaceId: "workspace-1",
      query: "What does the page explain?",
      stream: true,
    })) {
      events.push(event);
    }

    const streamedText = events
      .filter((event): event is Extract<ChatStreamEvent, { type: "chunk" }> => event.type === "chunk")
      .map((event) => event.text)
      .join("");
    const done = events.find((event): event is Extract<ChatStreamEvent, { type: "done" }> => event.type === "done");

    expect(streamedText).not.toContain("discount code");
    expect(streamedText).toBe(done?.answer);
    expect(done?.answer).not.toContain("discount code");
  });

  it("fails blank grounded streams instead of persisting an empty assistant turn", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = {
      async run() {
        return {
          rewrittenQuery: "what does this page do",
          contexts: [
            {
              chunkId: "chunk-1",
              documentId: "doc-1",
              title: "Intro",
              content: "full answer",
            },
          ],
          prompt: "prompt text",
          citations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Intro" }],
          diagnostics: {
            rewriteStatus: "skipped",
            rerankStatus: "skipped",
            originalCandidateCount: 1,
            rewrittenCandidateCount: 0,
            lexicalCandidateCount: 1,
            normalizedCandidateCount: 1,
            finalContextCount: 1,
            candidateFallbackApplied: false,
            fallbackApplied: false,
            parsedQuery: {
              semanticQuery: "page do",
              lexicalQuery: "page do",
              constraints: [],
            },
          },
          responseSettings: {
            citationDisplayEnabled: true,
          },
        };
      },
    } as const;
    const chatGateway: ChatGateway = {
      async answer() {
        return "   ";
      },
      async *streamAnswer() {
        yield "";
        yield "   ";
        yield "";
      },
    };
    const service = makeChatService(
      conversationRepository,
      messageRepository,
      new RetrievalTurnController(asChatActivityPipeline(retrievalPipeline) as never),
      chatGateway,
      auditService,
      fallbackReplyComposer,
    );

    const iterator = service.streamAnswer({
      workspaceId: "workspace-1",
      query: "What does this page do?",
      stream: true,
    })[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: {
        type: "conversation",
        conversationId: expect.any(String),
      },
    });
    await expect(iterator.next()).rejects.toBeInstanceOf(BlankChatAnswerError);

    const [conversationId] = conversationRepository.items.keys();
    const persisted = await messageRepository.listByConversationId("workspace-1", conversationId!);
    expect(persisted.map((message) => ({ role: message.role, content: message.content }))).toEqual([
      { role: "user", content: "What does this page do?" },
    ]);
    expect(auditService.events).toContainEqual(
      expect.objectContaining({
        eventType: "chat.answer",
        eventStatus: "failure",
        metadata: expect.objectContaining({
          errorMessage: "chat_answer_generation_failed",
          stream: true,
        }),
      }),
    );
  });

  it("rejects a well-formed envelope whose answer is blank in the non-streaming path", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = {
      async run() {
        return {
          rewrittenQuery: "what does this page do",
          contexts: [
            {
              chunkId: "chunk-1",
              documentId: "doc-1",
              title: "Intro",
              content: "full answer",
            },
          ],
          prompt: "prompt text",
          citations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Intro" }],
          diagnostics: {
            rewriteStatus: "skipped",
            rerankStatus: "skipped",
            originalCandidateCount: 1,
            rewrittenCandidateCount: 0,
            lexicalCandidateCount: 1,
            normalizedCandidateCount: 1,
            finalContextCount: 1,
            candidateFallbackApplied: false,
            fallbackApplied: false,
            parsedQuery: {
              semanticQuery: "page do",
              lexicalQuery: "page do",
              constraints: [],
            },
          },
          responseSettings: {
            citationDisplayEnabled: true,
          },
        };
      },
    } as const;
    const chatGateway: ChatGateway = {
      async answer() {
        return envelope("   ", []);
      },
      async *streamAnswer() {
        yield "unused";
      },
    };
    const service = makeChatService(
      conversationRepository,
      messageRepository,
      new RetrievalTurnController(asChatActivityPipeline(retrievalPipeline) as never),
      chatGateway,
      auditService,
      fallbackReplyComposer,
    );

    await expect(
      service.answer({
        workspaceId: "workspace-1",
        query: "What does this page do?",
        stream: false,
      }),
    ).rejects.toBeInstanceOf(BlankChatAnswerError);

    const [conversationId] = conversationRepository.items.keys();
    const persisted = await messageRepository.listByConversationId("workspace-1", conversationId!);
    expect(persisted.map((message) => ({ role: message.role, content: message.content }))).toEqual([
      { role: "user", content: "What does this page do?" },
    ]);
  });

  it("answers assistant identity questions without retrieved document context", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = createIntentRoutedNoContextPipeline({
      query: "What is your name and what do you do?",
      responseIntent: "assistant_identity",
      responseIdentity: {
        name: "Marta",
      },
    });
    const chatGateway: ChatGateway = {
      async answer() {
        return "My name is Marta. I am your museum guide.";
      },
      async *streamAnswer() {
        yield "unused";
      },
    };
    const service = makeChatService(
      conversationRepository,
      messageRepository,
      new RetrievalTurnController(asChatActivityPipeline(retrievalPipeline) as never),
      chatGateway,
      auditService,
      fallbackReplyComposer,
    );

    const response = await service.answer({
      workspaceId: "workspace-1",
      query: "What is your name and what do you do?",
      stream: false,
    });

    expect(response.answer).toContain("Marta");
    expect(response.answer).toContain("museum guide");
    expect(response.citations).toBeUndefined();
    expect(response.answerSegments).toBeUndefined();
  });

  it("falls back to the normal no-context response when the identity prompt returns blank output", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = createIntentRoutedNoContextPipeline({
      query: "What is your name?",
      responseIntent: "assistant_identity",
      responseIdentity: {
        name: "Marta",
      },
    });
    const chatGateway: ChatGateway = {
      async answer() {
        throw new BlankChatAnswerError();
      },
      async *streamAnswer() {
        yield "unused";
      },
    };
    const service = makeChatService(
      conversationRepository,
      messageRepository,
      new RetrievalTurnController(asChatActivityPipeline(retrievalPipeline) as never),
      chatGateway,
      auditService,
      fallbackReplyComposer,
    );

    const response = await service.answer({
      workspaceId: "workspace-1",
      query: "What is your name?",
      stream: false,
    });

    expect(response.answer).toEqual(expect.any(String));
    expect(response.answer.length).toBeGreaterThan(0);
  });

  it("does not swallow provider failures from the identity prompt", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = createIntentRoutedNoContextPipeline({
      query: "What is your name?",
      responseIntent: "assistant_identity",
      responseIdentity: {
        name: "Marta",
      },
    });
    const chatGateway: ChatGateway = {
      async answer() {
        throw new Error("provider unavailable");
      },
      async *streamAnswer() {
        yield "unused";
      },
    };
    const service = makeChatService(
      conversationRepository,
      messageRepository,
      new RetrievalTurnController(asChatActivityPipeline(retrievalPipeline) as never),
      chatGateway,
      auditService,
      fallbackReplyComposer,
    );

    await expect(
      service.answer({
        workspaceId: "workspace-1",
        query: "What is your name?",
        stream: false,
      }),
    ).rejects.toThrow("provider unavailable");

    expect(auditService.events).toContainEqual(
      expect.objectContaining({
        eventType: "chat.answer",
        eventStatus: "failure",
        metadata: expect.objectContaining({
          errorMessage: "provider unavailable",
        }),
      }),
    );
  });

  it("streams assistant identity answers for no-context follow-ups", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = createIntentRoutedNoContextPipeline({
      query: "What do you do?",
      responseIntent: "assistant_identity",
      responseIdentity: {
        name: "Marta",
      },
    });
    const chatGateway: ChatGateway = {
      async answer() {
        return "I am Marta, and I help visitors navigate the museum.";
      },
      async *streamAnswer() {
        yield "unused";
      },
    };
    const service = makeChatService(
      conversationRepository,
      messageRepository,
      new RetrievalTurnController(asChatActivityPipeline(retrievalPipeline) as never),
      chatGateway,
      auditService,
      fallbackReplyComposer,
    );

    const events: ChatStreamEvent[] = [];
    for await (const event of service.streamAnswer({
      workspaceId: "workspace-1",
      query: "What do you do?",
      stream: true,
    })) {
      events.push(event);
    }

    expect(events[0]).toEqual({ type: "conversation", conversationId: expect.any(String) });
    expect(events[1]).toEqual({ type: "chunk", text: expect.any(String) });
    expect(events[2]).toEqual(
      expect.objectContaining({
        type: "done",
        answer: expect.any(String),
      }),
    );
  });

  it("falls back to the normal no-context response when a streamed non-retrieval answer is blank", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = createIntentRoutedNoContextPipeline({
      query: "What do you do?",
      responseIntent: "assistant_identity",
      responseIdentity: {
        name: "Marta",
      },
    });
    const chatGateway: ChatGateway = {
      async answer() {
        throw new BlankChatAnswerError();
      },
      async *streamAnswer() {
        // A blank stream — the non-retrieval skill falls back to the no-context reply.
        yield "";
      },
    };
    const service = makeChatService(
      conversationRepository,
      messageRepository,
      new RetrievalTurnController(asChatActivityPipeline(retrievalPipeline) as never),
      chatGateway,
      auditService,
      fallbackReplyComposer,
    );

    const events: ChatStreamEvent[] = [];
    for await (const event of service.streamAnswer({
      workspaceId: "workspace-1",
      query: "What do you do?",
      stream: true,
    })) {
      events.push(event);
    }

    expect(events[1]).toEqual({
      type: "chunk",
      text: "I couldn't find supporting material for that in your workspace documents. If you'd like, try asking about a topic that's covered there.",
    });
    expect(events[2]).toEqual(
      expect.objectContaining({
        type: "done",
        answer: "I couldn't find supporting material for that in your workspace documents. If you'd like, try asking about a topic that's covered there.",
      }),
    );
  });

  it("does not treat broader task questions as assistant identity questions", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = {
      async run() {
        return {
          rewrittenQuery: "what can you do with these documents",
          contexts: [],
          prompt: "unused retrieval prompt",
          citations: [],
          responseIdentity: {
            name: "Marta",
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
            parsedQuery: {
              semanticQuery: "what can you do with these documents",
              lexicalQuery: "what can you do with these documents",
              constraints: [],
            },
          },
          responseSettings: {
            citationDisplayEnabled: true,
          },
        };
      },
    } as const;
    const chatGateway: ChatGateway = {
      async answer() {
        throw new Error("identity prompt should not run");
      },
      async *streamAnswer() {
        yield "unused";
      },
    };
    const service = makeChatService(
      conversationRepository,
      messageRepository,
      new RetrievalTurnController(asChatActivityPipeline(retrievalPipeline) as never),
      chatGateway,
      auditService,
      fallbackReplyComposer,
    );

    const response = await service.answer({
      workspaceId: "workspace-1",
      query: "What can you do with these documents?",
      stream: false,
    });

    expect(response.answer).toEqual(expect.any(String));
    expect(response.answer.length).toBeGreaterThan(0);
    expect(response.citations).toBeUndefined();
  });

  it("passes assistant instructions into retrieval no-context fallback", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    let observedNoContextInstruction = "";
    const retrievalPipeline = {
      async run() {
        return {
          rewrittenQuery: "I like potato chips",
          contexts: [],
          prompt: "unused retrieval prompt",
          citations: [],
          responseIdentity: {
            name: "Vikram",
          },
          diagnostics: {
            rewriteStatus: "skipped",
            rerankStatus: "fallback",
            originalCandidateCount: 0,
            rewrittenCandidateCount: 0,
            lexicalCandidateCount: 0,
            normalizedCandidateCount: 0,
            finalContextCount: 0,
            candidateFallbackApplied: false,
            fallbackApplied: true,
            responseIntent: "retrieval",
            retrievalSkipped: false,
            parsedQuery: {
              semanticQuery: "I like potato chips",
              lexicalQuery: "I like potato chips",
              constraints: [],
            },
          },
          responseSettings: {
            citationDisplayEnabled: true,
            customInstruction: "Help visitors choose and book Ananda courses.",
            responseLanguagePolicy: "match_user_question",
          },
        };
      },
    } as const;
    const chatGateway: ChatGateway = {
      async answer() {
        throw new Error("retrieval answer should not run without contexts");
      },
      async *streamAnswer() {
        yield "unused";
      },
    };
    const fallbackComposer: FallbackReplyComposer = {
      async composeNoContext(input) {
        observedNoContextInstruction = input.answerInstructionBlock ?? "";
        return "I can't tell from that. I can help you choose and book Ananda courses.";
      },
    };
    const service = makeChatService(
      conversationRepository,
      messageRepository,
      new RetrievalTurnController(asChatActivityPipeline(retrievalPipeline) as never),
      chatGateway,
      auditService,
      fallbackComposer,
    );

    const response = await service.answer({
      workspaceId: "workspace-1",
      query: "I like potato chips",
      stream: false,
    });

    expect(response.answer).toBe("I can't tell from that. I can help you choose and book Ananda courses.");
    expect(observedNoContextInstruction).toContain("Stable assistant identity:");
    expect(observedNoContextInstruction).toContain("Vikram");
    expect(observedNoContextInstruction).toContain("Configured response instructions:");
    expect(observedNoContextInstruction).toContain("Help visitors choose and book Ananda courses.");
  });

  it("excludes URL-shaped citation titles from carry-forward literals", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = {
      async run(input: { query: string }) {
        return {
          rewrittenQuery: input.query,
          contexts: [
            {
              chunkId: "chunk-1",
              documentId: "doc-1",
              title: "https://riigiteataja.ee/akt/118122025017.xml",
              content: "full answer",
            },
          ],
          prompt: "prompt text",
          citations: [
            {
              documentId: "doc-1",
              chunkId: "chunk-1",
              title: "https://riigiteataja.ee/akt/118122025017.xml",
            },
          ],
          diagnostics: {
            rewriteStatus: "applied",
            rerankStatus: "skipped",
            originalCandidateCount: 1,
            rewrittenCandidateCount: 0,
            lexicalCandidateCount: 0,
            normalizedCandidateCount: 1,
            finalContextCount: 1,
            candidateFallbackApplied: false,
            fallbackApplied: false,
            rewriteProposal: {
              rewrittenQuery: "Eestis hetkel kehtiv kaibemaksumaar (KM)",
              turnKind: "fresh_subject",
              proposedActiveSubject: "kaibemaksumaar Eestis",
              relatedEntities: [],
              unresolved: false,
              confidence: 0.8,
            },
            parsedQuery: {
              semanticQuery: "kaibemaks",
              lexicalQuery: "kaibemaks",
              constraints: [],
            },
          },
          responseSettings: {
            citationDisplayEnabled: true,
          },
        };
      },
    } as const;
    const chatGateway: ChatGateway = {
      async answer() {
        return "full answer[[1]]";
      },
      async *streamAnswer() {
        yield "full answer[[1]]";
      },
    };
    const service = makeChatService(
      conversationRepository,
      messageRepository,
      new RetrievalTurnController(asChatActivityPipeline(retrievalPipeline) as never),
      chatGateway,
      auditService,
      fallbackReplyComposer,
    );

    const first = await service.answer({
      workspaceId: "workspace-1",
      accountId: "account-1",
      query: "Mis juhtub, kui ma ei maksa tulumaksu?",
      stream: false,
    });

    await service.answer({
      workspaceId: "workspace-1",
      accountId: "account-1",
      conversationId: first.conversationId,
      query: "mis on hetkel kehtiv kaibemaks?",
      stream: false,
    });

    expect(auditService.events[0]?.metadata?.rewriteContinuityState).toEqual({
      activeSubject: "kaibemaksumaar Eestis",
      relatedEntities: [],
      groundedTitles: [],
    });
  });

  it("drops inferred related entities from rewrite continuity state", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = {
      async run() {
        return {
          rewrittenQuery: "Does Narayani work with Arudra?",
          contexts: [
            {
              chunkId: "chunk-1",
              documentId: "doc-1",
              title: "Narayani",
              content: "full answer",
            },
          ],
          prompt: "prompt text",
          citations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Narayani" }],
          diagnostics: {
            rewriteStatus: "applied",
            rerankStatus: "skipped",
            originalCandidateCount: 1,
            rewrittenCandidateCount: 0,
            lexicalCandidateCount: 1,
            normalizedCandidateCount: 1,
            finalContextCount: 1,
            candidateFallbackApplied: false,
            fallbackApplied: false,
            rewriteProposal: {
              rewrittenQuery: "Does Narayani work with Arudra?",
              turnKind: "referential_relation",
              proposedActiveSubject: "Narayani",
              relatedEntities: ["Arudra"],
              unresolved: true,
              confidence: 0.62,
            },
            parsedQuery: {
              semanticQuery: "does narayani work with arudra",
              lexicalQuery: "does narayani work with arudra",
              constraints: [],
            },
          },
          responseSettings: {
            citationDisplayEnabled: true,
          },
        };
      },
    } as const;
    const chatGateway: ChatGateway = {
      async answer() {
        return "full answer[[1]]";
      },
      async *streamAnswer() {
        yield "full answer[[1]]";
      },
    };
    const service = makeChatService(
      conversationRepository,
      messageRepository,
      new RetrievalTurnController(asChatActivityPipeline(retrievalPipeline) as never),
      chatGateway,
      auditService,
      fallbackReplyComposer,
    );

    await service.answer({
      workspaceId: "workspace-1",
      accountId: "account-1",
      query: "Does she work with Arudra?",
      stream: false,
    });

    expect(auditService.events[0]?.metadata?.rewriteContinuityState).toEqual({
      activeSubject: "Narayani",
      relatedEntities: [],
      groundedTitles: ["Narayani"],
    });
  });

  it("includes the normalized final answer in the done event when a malformed anchor is truncated during streaming", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = {
      async run() {
        return {
          rewrittenQuery: "what does this page do",
          contexts: [
            {
              chunkId: "chunk-1",
              documentId: "doc-1",
              title: "Intro",
              content: "full answer",
            },
          ],
          prompt: "prompt text",
          citations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Intro" }],
          diagnostics: {
            rewriteStatus: "skipped",
            rerankStatus: "skipped",
            originalCandidateCount: 1,
            rewrittenCandidateCount: 0,
            lexicalCandidateCount: 1,
            normalizedCandidateCount: 1,
            finalContextCount: 1,
            candidateFallbackApplied: false,
            fallbackApplied: false,
            parsedQuery: {
              semanticQuery: "page do",
              lexicalQuery: "page do",
              constraints: [],
            },
          },
        };
      },
    } as const;
    const chatGateway: ChatGateway = {
      async answer() {
        return "full answer [[ marker";
      },
      async *streamAnswer() {
        yield "full answer [[";
        yield " marker";
      },
    };
    const service = makeChatService(
      conversationRepository,
      messageRepository,
      new RetrievalTurnController(asChatActivityPipeline(retrievalPipeline) as never),
      chatGateway,
      auditService,
      fallbackReplyComposer,
    );

    const chunkTexts: string[] = [];
    let doneEvent: Extract<ChatStreamEvent, { type: "done" }> | undefined;

    for await (const event of service.streamAnswer({
      workspaceId: "workspace-1",
      query: "What does this page do?",
      stream: true,
    })) {
      if (event.type === "chunk") {
        chunkTexts.push(event.text);
      }

      if (event.type === "done") {
        doneEvent = event;
      }
    }

    expect(chunkTexts.join("")).toBe("full answer  marker");
    expect(doneEvent).toEqual(expect.objectContaining({
      type: "done",
      conversationId: expect.any(String),
      answer: "full answer  marker",
      citations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Intro" }],
      answerSegments: [{ text: "full answer  marker", citationIndices: [0] }],
      activitySummary: expect.objectContaining({
        candidateCounts: {
          semantic: 1,
          lexical: 1,
          merged: 1,
          final: 1,
        },
      }),
      activityTrace: expect.objectContaining({
        stages: expect.arrayContaining([
          expect.objectContaining({
            stageId: "answer",
            kind: "answer_outcome",
            status: "applied",
          }),
        ]),
      }),
    }));

    const [conversationId] = conversationRepository.items.keys();
    const persisted = await messageRepository.listByConversationId("workspace-1", conversationId!);
    expect(persisted.at(-1)).toMatchObject({
      role: "assistant",
      content: "full answer  marker",
    });
  });

  it("drops trailing incomplete citation anchor carry when the stream ends", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = {
      async run() {
        return {
          rewrittenQuery: "what does this page do",
          contexts: [
            {
              chunkId: "chunk-1",
              documentId: "doc-1",
              title: "Intro",
              content: "full answer",
            },
          ],
          prompt: "prompt text",
          citations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Intro" }],
          diagnostics: {
            rewriteStatus: "skipped",
            rerankStatus: "skipped",
            originalCandidateCount: 1,
            rewrittenCandidateCount: 0,
            lexicalCandidateCount: 1,
            normalizedCandidateCount: 1,
            finalContextCount: 1,
            candidateFallbackApplied: false,
            fallbackApplied: false,
            parsedQuery: {
              semanticQuery: "page do",
              lexicalQuery: "page do",
              constraints: [],
            },
          },
        };
      },
    } as const;
    const chatGateway: ChatGateway = {
      async answer() {
        return "full answer[[";
      },
      async *streamAnswer() {
        yield "full answer[[";
      },
    };
    const service = makeChatService(
      conversationRepository,
      messageRepository,
      new RetrievalTurnController(asChatActivityPipeline(retrievalPipeline) as never),
      chatGateway,
      auditService,
      fallbackReplyComposer,
    );

    const chunkTexts: string[] = [];
    let doneEvent: Extract<ChatStreamEvent, { type: "done" }> | undefined;

    for await (const event of service.streamAnswer({
      workspaceId: "workspace-1",
      query: "What does this page do?",
      stream: true,
    })) {
      if (event.type === "chunk") {
        chunkTexts.push(event.text);
      }

      if (event.type === "done") {
        doneEvent = event;
      }
    }

    expect(chunkTexts).toEqual(["full answer"]);
    expect(doneEvent).toEqual({
      type: "done",
      conversationId: expect.any(String),
      agentId: "workspace-1",
      agentName: "",
      assistantMessageId: expect.any(String),
      route: {
        type: "retrieval",
        reason: "evidence_required",
      },
      answer: "full answer",
      citations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Intro" }],
      answerSegments: [
        { text: "full answer", citationIndices: [0] },
      ],
      suggestions: undefined,
      activitySummary: expect.objectContaining({
        candidateCounts: {
          semantic: 1,
          lexical: 1,
          merged: 1,
          final: 1,
        },
      }),
      activityTrace: expect.objectContaining({
        stages: expect.arrayContaining([
          expect.objectContaining({
            stageId: "answer",
            kind: "answer_outcome",
            status: "applied",
          }),
        ]),
      }),
    });

    const [conversationId] = conversationRepository.items.keys();
    const persisted = await messageRepository.listByConversationId("workspace-1", conversationId!);
    expect(persisted.at(-1)).toMatchObject({
      role: "assistant",
      content: "full answer",
    });
  });

  it("does not persist a duplicate assistant turn when touch fails after the assistant answer is written", async () => {
    class FailingTouchConversationRepository extends InMemoryConversationRepository {
      override async touch(_conversationId: string, _workspaceId: string): Promise<void> {
        throw new Error("touch failed");
      }
    }

    const conversationRepository = new FailingTouchConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = {
      async run() {
        return {
          contexts: [],
          prompt: "prompt text",
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
            parsedQuery: {
              semanticQuery: "",
              lexicalQuery: "",
              constraints: [],
            },
          },
        };
      },
    } as const;
    const chatGateway: ChatGateway = {
      async answer() {
        return "full answer";
      },
      async *streamAnswer() {
        yield "full answer";
      },
    };
    const service = makeChatService(
      conversationRepository,
      messageRepository,
      new RetrievalTurnController(asChatActivityPipeline(retrievalPipeline) as never),
      chatGateway,
      auditService,
      fallbackReplyComposer,
    );

    await expect(service.answer({
      workspaceId: "workspace-1",
      query: "What does this page do?",
      stream: false,
    })).rejects.toThrow("touch failed");

    const [conversationId] = conversationRepository.items.keys();
    const persisted = await messageRepository.listByConversationId("workspace-1", conversationId!);
    expect(persisted.map((message) => ({ role: message.role, content: message.content }))).toEqual([
      { role: "user", content: "What does this page do?" },
      {
        role: "assistant",
        content: expect.any(String),
      },
    ]);
  });

  it("keeps the persisted user turn when retrieval fails after intake has declined", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = {
      async run() {
        throw new Error("retrieval failed");
      },
    } as const;
    const chatGateway: ChatGateway = {
      async answer() {
        return "unused";
      },
      async *streamAnswer() {
        yield "unused";
      },
    };
    const service = makeChatService(
      conversationRepository,
      messageRepository,
      new RetrievalTurnController(asChatActivityPipeline(retrievalPipeline) as never),
      chatGateway,
      auditService,
    );

    await expect(service.answer({
      workspaceId: "workspace-1",
      query: "What does this page do?",
      stream: false,
    })).rejects.toThrow("retrieval failed");

    const [conversationId] = conversationRepository.items.keys();
    expect(conversationId).toEqual(expect.any(String));
    const persisted = await messageRepository.listByConversationId("workspace-1", conversationId!);
    expect(persisted.map((message) => ({ role: message.role, content: message.content }))).toEqual([
      { role: "user", content: "What does this page do?" },
    ]);
  });

  it("preserves mixed-support content in a non-streaming grounded answer", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = {
      async run() {
        return {
          rewrittenQuery: "what does this page do",
          contexts: [
            {
              chunkId: "chunk-1",
              documentId: "doc-1",
              title: "Guide",
              content: "The page explains testing and parsing content for users.",
            },
          ],
          prompt: "prompt text",
          citations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Guide" }],
          diagnostics: {
            rewriteStatus: "skipped",
            rerankStatus: "skipped",
            originalCandidateCount: 1,
            rewrittenCandidateCount: 0,
            lexicalCandidateCount: 1,
            normalizedCandidateCount: 1,
            finalContextCount: 1,
            candidateFallbackApplied: false,
            fallbackApplied: false,
            parsedQuery: {
              semanticQuery: "page do",
              lexicalQuery: "page do",
              constraints: [],
            },
          },
          responseSettings: {
            citationDisplayEnabled: true,
          },
        };
      },
    } as const;
    const chatGateway: ChatGateway = {
      async answer() {
        return "The page explains testing and parsing content for users. It also offers 24/7 phone support.";
      },
      async *streamAnswer() {
        yield "unused";
      },
    };
    const service = makeChatService(
      conversationRepository,
      messageRepository,
      new RetrievalTurnController(asChatActivityPipeline(retrievalPipeline) as never),
      chatGateway,
      auditService,
    );

    const response = await service.answer({
      workspaceId: "workspace-1",
      accountId: "account-1",
      query: "What does this page do?",
      stream: false,
    });

    expect(response.answer).toContain("24/7 phone support");
    expect(response.answerSegments).toHaveLength(2);
    expect(response.answerSegments?.[0]).toEqual(
      expect.objectContaining({ citationIndices: [0] }),
    );
    expect(response.answerSegments?.[1]?.citationIndices).toBeUndefined();
    expect(response.answerSegments?.map((segment) => segment.text).join("")).toContain(
      "24/7 phone support",
    );

    const [conversationId] = conversationRepository.items.keys();
    const persisted = await messageRepository.listByConversationId("workspace-1", conversationId!);
    expect(persisted.at(-1)?.content).toBe(response.answer);
  });

  it("preserves generated content outside cited segments", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = {
      async run() {
        return {
          rewrittenQuery: "what does this page do",
          contexts: [
            {
              chunkId: "chunk-1",
              documentId: "doc-1",
              title: "Guide",
              content: "The page explains testing and parsing content for users.",
            },
          ],
          prompt: "prompt text",
          citations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Guide" }],
          diagnostics: {
            rewriteStatus: "skipped",
            rerankStatus: "skipped",
            originalCandidateCount: 1,
            rewrittenCandidateCount: 0,
            lexicalCandidateCount: 1,
            normalizedCandidateCount: 1,
            finalContextCount: 1,
            candidateFallbackApplied: false,
            fallbackApplied: false,
            parsedQuery: {
              semanticQuery: "page do",
              lexicalQuery: "page do",
              constraints: [],
            },
          },
          responseSettings: {
            citationDisplayEnabled: true,
          },
        };
      },
    } as const;
    const chatGateway: ChatGateway = {
      async answer() {
        return "The page explains testing and parsing content for users[[1]]. It also offers 24/7 phone support.";
      },
      async *streamAnswer() {
        yield "unused";
      },
    };
    const service = makeChatService(
      conversationRepository,
      messageRepository,
      new RetrievalTurnController(asChatActivityPipeline(retrievalPipeline) as never),
      chatGateway,
      auditService,
    );

    const response = await service.answer({
      workspaceId: "workspace-1",
      accountId: "account-1",
      query: "What does this page do?",
      stream: false,
    });

    expect(response.answer).toContain("24/7 phone support");
    expect(response.citations).toEqual([{ documentId: "doc-1", chunkId: "chunk-1", title: "Guide" }]);
    expect(response.answerSegments).toEqual([
      {
        text: "The page explains testing and parsing content for users",
        citationIndices: [0],
      },
      {
        text: ". It also offers 24/7 phone support.",
      },
    ]);
    expect(response.activityTrace.stages).toEqual(expect.arrayContaining([
      expect.objectContaining({ stageId: "answer" }),
    ]));
  });

  it("records a grounded_degraded outcome when the model flags weak grounding", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = {
      async run() {
        return {
          rewrittenQuery: "what does this page do",
          contexts: [
            {
              chunkId: "chunk-1",
              documentId: "doc-1",
              title: "Guide",
              content: "The page explains testing and parsing content for users.",
            },
          ],
          prompt: "prompt text",
          citations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Guide" }],
          diagnostics: {
            rewriteStatus: "skipped",
            rerankStatus: "skipped",
            originalCandidateCount: 1,
            rewrittenCandidateCount: 0,
            lexicalCandidateCount: 1,
            normalizedCandidateCount: 1,
            finalContextCount: 1,
            candidateFallbackApplied: false,
            fallbackApplied: false,
            parsedQuery: { semanticQuery: "page do", lexicalQuery: "page do", constraints: [] },
          },
          responseSettings: { citationDisplayEnabled: true },
        };
      },
    } as const;
    const chatGateway: ChatGateway = {
      async answer() {
        return groundingEnvelope(
          "The page explains testing and parsing content for users[[1]], though the materials don't cover edge cases.",
          "degraded",
        );
      },
      async *streamAnswer() {
        yield "unused";
      },
    };
    const service = makeChatService(
      conversationRepository,
      messageRepository,
      new RetrievalTurnController(asChatActivityPipeline(retrievalPipeline) as never),
      chatGateway,
      auditService,
    );

    const response = await service.answer({
      workspaceId: "workspace-1",
      accountId: "account-1",
      query: "What does this page do?",
      stream: false,
    });

    expect(response.citations).toEqual([{ documentId: "doc-1", chunkId: "chunk-1", title: "Guide" }]);
    const [conversationId] = conversationRepository.items.keys();
    const persisted = await messageRepository.listByConversationId("workspace-1", conversationId!);
    expect(persisted.at(-1)).toMatchObject({
      skillName: "retrieval.answer",
      skillOutcome: "grounded_degraded",
      skillStatus: "completed",
    });
  });

  it("keeps a degraded verdict from overriding the no-context grounded miss", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = {
      async run() {
        return {
          rewrittenQuery: "what does this page do",
          contexts: [
            {
              chunkId: "chunk-1",
              documentId: "doc-1",
              title: "Guide",
              content: "The page explains testing and parsing content for users.",
            },
          ],
          prompt: "prompt text",
          citations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Guide" }],
          diagnostics: {
            rewriteStatus: "skipped",
            rerankStatus: "skipped",
            originalCandidateCount: 1,
            rewrittenCandidateCount: 0,
            lexicalCandidateCount: 1,
            normalizedCandidateCount: 1,
            finalContextCount: 1,
            candidateFallbackApplied: false,
            fallbackApplied: false,
            parsedQuery: { semanticQuery: "page do", lexicalQuery: "page do", constraints: [] },
          },
          responseSettings: { citationDisplayEnabled: true },
        };
      },
    } as const;
    const chatGateway: ChatGateway = {
      async answer() {
        // Degraded verdict, but the model cited nothing — the grounded-miss safety
        // net must still win and classify the turn as no_context.
        return groundingEnvelope("We don't have specific details on that.", "degraded");
      },
      async *streamAnswer() {
        yield "unused";
      },
    };
    const service = makeChatService(
      conversationRepository,
      messageRepository,
      new RetrievalTurnController(asChatActivityPipeline(retrievalPipeline) as never),
      chatGateway,
      auditService,
    );

    await service.answer({
      workspaceId: "workspace-1",
      accountId: "account-1",
      query: "What does this page do?",
      stream: false,
    });

    const [conversationId] = conversationRepository.items.keys();
    const persisted = await messageRepository.listByConversationId("workspace-1", conversationId!);
    expect(persisted.at(-1)).toMatchObject({
      skillName: "retrieval.answer",
      skillOutcome: "no_context",
    });
  });

  it("plans grounded suggestions for cited answers", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = {
      async run() {
        return {
          rewrittenQuery: "what does the guide cover",
          contexts: [
            {
              chunkId: "chunk-1",
              documentId: "doc-1",
              title: "Guide",
              content: "The guide covers parser setup and onboarding workflows. It also explains import audits.",
            },
          ],
          prompt: "prompt text",
          citations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Guide" }],
          diagnostics: {
            rewriteStatus: "skipped",
            rerankStatus: "skipped",
            originalCandidateCount: 1,
            rewrittenCandidateCount: 0,
            lexicalCandidateCount: 1,
            normalizedCandidateCount: 1,
            finalContextCount: 1,
            candidateFallbackApplied: false,
            fallbackApplied: false,
            parsedQuery: {
              semanticQuery: "guide cover",
              lexicalQuery: "guide cover",
              constraints: [],
            },
          },
          responseSettings: {
            citationDisplayEnabled: true,
            suggestedQuestionsEnabled: true,
            suggestedQuestionsCount: 2,
          },
        };
      },
    } as const;
    const chatGateway: ChatGateway = {
      async answer({ systemPrompt }) {
        const answerText = "The guide covers parser setup and onboarding workflows.";
        if (systemPrompt?.includes("Output envelope")) {
          return envelope(answerText, [
            { text: "How do import audits work?", kind: "deeper", contextIndex: 1 },
          ]);
        }
        return answerText;
      },
      async *streamAnswer() {
        yield "unused";
      },
    };
    const service = makeChatService(
      conversationRepository,
      messageRepository,
      new RetrievalTurnController(asChatActivityPipeline(retrievalPipeline) as never),
      chatGateway,
      auditService,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      groundedSkillCapabilities,
    );

    const response = await service.answer({
      workspaceId: "workspace-1",
      accountId: "account-1",
      query: "What does the guide cover?",
      stream: false,
    });

    expect(response.suggestions).toEqual([
      expect.objectContaining({
        text: "How do import audits work?",
        kind: "deeper",
        citation: {
          documentId: "doc-1",
          chunkId: "chunk-1",
          title: "Guide",
        },
      }),
    ]);
    expect(response.activityTrace.stages).toEqual(expect.arrayContaining([
      expect.objectContaining({ stageId: "answer" }),
    ]));
  });

  it("does not plan grounded suggestions when no citation attaches", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = {
      async run() {
        return {
          rewrittenQuery: "what does the guide cover",
          contexts: [
            {
              chunkId: "chunk-1",
              documentId: "doc-1",
              title: "Guide",
              content: "The guide covers parser setup and onboarding workflows.",
            },
          ],
          prompt: "prompt text",
          citations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Guide" }],
          diagnostics: {
            rewriteStatus: "skipped",
            rerankStatus: "skipped",
            originalCandidateCount: 1,
            rewrittenCandidateCount: 0,
            lexicalCandidateCount: 1,
            normalizedCandidateCount: 1,
            finalContextCount: 1,
            candidateFallbackApplied: false,
            fallbackApplied: false,
            parsedQuery: {
              semanticQuery: "guide cover",
              lexicalQuery: "guide cover",
              constraints: [],
            },
          },
          responseSettings: {
            citationDisplayEnabled: true,
            suggestedQuestionsEnabled: true,
            suggestedQuestionsCount: 2,
          },
        };
      },
    } as const;
    const chatGateway: ChatGateway = {
      async answer({ systemPrompt }) {
        const answerText = "Thanks for asking.";
        if (systemPrompt?.includes("Output envelope")) {
          // Envelope is requested even when the answer ends up uncited; the presenter
          // gating drops suggestions for uncited answers.
          return envelope(answerText, [
            { text: "Should not appear.", kind: "deeper", contextIndex: 1 },
          ]);
        }
        return answerText;
      },
      async *streamAnswer() {
        yield "unused";
      },
    };
    const service = makeChatService(
      conversationRepository,
      messageRepository,
      new RetrievalTurnController(asChatActivityPipeline(retrievalPipeline) as never),
      chatGateway,
      auditService,
    );

    const response = await service.answer({
      workspaceId: "workspace-1",
      accountId: "account-1",
      query: "What does the guide cover?",
      stream: false,
    });

    expect(response.citations).toBeUndefined();
    expect(response.suggestions).toBeUndefined();
  });

  it("preserves assistant bootstrap claims alongside grounded document claims in non-streaming answers", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = {
      async run() {
        return {
          rewrittenQuery: "what does this page do",
          contexts: [
            {
              chunkId: "chunk-1",
              documentId: "doc-1",
              title: "Guide",
              content: "The page explains testing and parsing content for users.",
            },
          ],
          prompt: "prompt text",
          citations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Guide" }],
          responseIdentity: {
            name: "Vikram",
          },
          diagnostics: {
            rewriteStatus: "skipped",
            rerankStatus: "skipped",
            originalCandidateCount: 1,
            rewrittenCandidateCount: 0,
            lexicalCandidateCount: 1,
            normalizedCandidateCount: 1,
            finalContextCount: 1,
            candidateFallbackApplied: false,
            fallbackApplied: false,
            parsedQuery: {
              semanticQuery: "page do",
              lexicalQuery: "page do",
              constraints: [],
            },
          },
          responseSettings: {
            citationDisplayEnabled: true,
          },
        };
      },
    } as const;
    const chatGateway: ChatGateway = {
      async answer() {
        return "I'm Vikram. The page explains testing and parsing content for users.";
      },
      async *streamAnswer() {
        yield "unused";
      },
    };
    const service = makeChatService(
      conversationRepository,
      messageRepository,
      new RetrievalTurnController(asChatActivityPipeline(retrievalPipeline) as never),
      chatGateway,
      auditService,
      fallbackReplyComposer,
    );

    const response = await service.answer({
      workspaceId: "workspace-1",
      accountId: "account-1",
      query: "What does this page do?",
      stream: false,
    });

    expect(response.answer).toContain("Vikram");
    expect(response.answer).toContain("testing and parsing");
    expect(response.citations).toEqual([
      { documentId: "doc-1", chunkId: "chunk-1", title: "Guide" },
    ]);
    expect(response.answerSegments).toEqual([
      expect.objectContaining({ text: expect.any(String) }),
      expect.objectContaining({ text: expect.any(String), citationIndices: [0] }),
    ]);

    const [conversationId] = conversationRepository.items.keys();
    const persisted = await messageRepository.listByConversationId("workspace-1", conversationId!);
    expect(persisted.at(-1)?.content).toBe(response.answer);
  });

  it("streams the validated strict-mode answer and keeps uncited content in the final answer", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = {
      async run() {
        return {
          rewrittenQuery: "what does this page do",
          contexts: [
            {
              chunkId: "chunk-1",
              documentId: "doc-1",
              title: "Guide",
              content: "The page explains testing and parsing content for users.",
            },
          ],
          prompt: "prompt text",
          citations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Guide" }],
          diagnostics: {
            rewriteStatus: "skipped",
            rerankStatus: "skipped",
            originalCandidateCount: 1,
            rewrittenCandidateCount: 0,
            lexicalCandidateCount: 1,
            normalizedCandidateCount: 1,
            finalContextCount: 1,
            candidateFallbackApplied: false,
            fallbackApplied: false,
            parsedQuery: {
              semanticQuery: "page do",
              lexicalQuery: "page do",
              constraints: [],
            },
          },
          responseSettings: {
            citationDisplayEnabled: true,
          },
        };
      },
    } as const;
    const chatGateway: ChatGateway = {
      async answer() {
        return "unused";
      },
      async *streamAnswer() {
        yield "The page explains testing and parsing content for users[[1]]. ";
        yield "It also offers 24/7 phone support.";
      },
    };
    const service = makeChatService(
      conversationRepository,
      messageRepository,
      new RetrievalTurnController(asChatActivityPipeline(retrievalPipeline) as never),
      chatGateway,
      auditService,
    );

    const iterator = service.streamAnswer({
      workspaceId: "workspace-1",
      accountId: "account-1",
      query: "What does this page do?",
      stream: true,
    })[Symbol.asyncIterator]();

    const conversationEvent = await iterator.next();

    expect(conversationEvent.value).toEqual({
      type: "conversation",
      conversationId: expect.any(String),
    });

    const events: ChatStreamEvent[] = [conversationEvent.value!];
    for await (const event of { [Symbol.asyncIterator]: () => iterator }) {
      events.push(event);
    }

    const streamedText = events
      .filter((event): event is Extract<ChatStreamEvent, { type: "chunk" }> => event.type === "chunk")
      .map((event) => event.text)
      .join("");

    expect(streamedText).toBe("The page explains testing and parsing content for users. It also offers 24/7 phone support.");
    expect(streamedText).toContain("24/7 phone support");
    expect(events.findIndex((event) => event.type === "chunk")).toBeGreaterThanOrEqual(0);
    expect(events.findIndex((event) => event.type === "chunk")).toBeLessThan(
      events.findIndex((event) => event.type === "done"),
    );
    expect(events.at(-1)).toEqual(
      expect.objectContaining({
        type: "done",
        answer: "The page explains testing and parsing content for users. It also offers 24/7 phone support.",
      }),
    );
  });

  it("does not stream an uncited warn-mode draft when the final outcome is a grounded miss", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = {
      async run() {
        return {
          rewrittenQuery: "who is narayani",
          contexts: [
            {
              chunkId: "chunk-1",
              documentId: "doc-1",
              title: "Event listing",
              content: "Narayani leads a satsang this weekend.",
            },
          ],
          prompt: "prompt text",
          citations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Event listing" }],
          diagnostics: {
            rewriteStatus: "skipped",
            rerankStatus: "skipped",
            originalCandidateCount: 1,
            rewrittenCandidateCount: 0,
            lexicalCandidateCount: 1,
            normalizedCandidateCount: 1,
            finalContextCount: 1,
            candidateFallbackApplied: false,
            fallbackApplied: false,
            parsedQuery: {
              semanticQuery: "who is narayani",
              lexicalQuery: "who is narayani",
              constraints: [],
            },
          },
          responseSettings: {
            citationDisplayEnabled: true,
          },
        };
      },
    } as const;
    const chatGateway: ChatGateway = {
      async answer() {
        return "unused";
      },
      async *streamAnswer() {
        yield "Narayani is a teacher";
        yield " and author.";
      },
    };
    const service = makeChatService(
      conversationRepository,
      messageRepository,
      new RetrievalTurnController(asChatActivityPipeline(retrievalPipeline) as never),
      chatGateway,
      auditService,
    );

    const events: ChatStreamEvent[] = [];

    for await (const event of service.streamAnswer({
      workspaceId: "workspace-1",
      accountId: "account-1",
      query: "Who is Narayani?",
      stream: true,
    })) {
      events.push(event);
    }

    const chunkTexts = events
      .filter((event): event is Extract<ChatStreamEvent, { type: "chunk" }> => event.type === "chunk")
      .map((event) => event.text);

    expect(chunkTexts.join("")).toBe("I can't answer that from my current focus. Try asking about the topics I can help with.");
    expect(events.at(-1)).toEqual(
      expect.objectContaining({
        type: "done",
        answer: "I can't answer that from my current focus. Try asking about the topics I can help with.",
        activityTrace: expect.objectContaining({
          stages: expect.arrayContaining([
            expect.objectContaining({
              stageId: "answer",
              kind: "answer_outcome",
              outputs: expect.objectContaining({
                outcome: "no_context_refusal",
              }),
            }),
          ]),
        }),
      }),
    );
  });

  it("does not infer expansion metadata from inline answer formatting", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = {
      async run() {
        return {
          rewrittenQuery: "what does this page do",
          contexts: [
            {
              chunkId: "chunk-1",
              documentId: "doc-1",
              title: "Guide",
              content: "The page explains testing and parsing content for users. The FAQ covers onboarding. The notes cover examples.",
            },
          ],
          prompt: "prompt text",
          citations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Guide" }],
          diagnostics: {
            rewriteStatus: "skipped",
            rerankStatus: "skipped",
            originalCandidateCount: 1,
            rewrittenCandidateCount: 0,
            lexicalCandidateCount: 1,
            normalizedCandidateCount: 1,
            finalContextCount: 1,
            candidateFallbackApplied: false,
            fallbackApplied: false,
            parsedQuery: {
              semanticQuery: "page do",
              lexicalQuery: "page do",
              constraints: [],
            },
          },
          responseSettings: {
            citationDisplayEnabled: true,
          },
        };
      },
    } as const;
    const chatGateway: ChatGateway = {
      async answer({ systemPrompt }) {
        const answerText = [
          "The page explains testing and parsing content for users[[1]].",
          "",
          "- You can also inspect the onboarding FAQ[[1]].",
          "- The notes include worked examples[[1]].",
        ].join("\n");
        if (systemPrompt?.includes("Output envelope")) {
          return envelope(answerText, []);
        }
        return answerText;
      },
      async *streamAnswer() {
        yield "";
      },
    };
    const service = makeChatService(
      conversationRepository,
      messageRepository,
      new RetrievalTurnController(asChatActivityPipeline(retrievalPipeline) as never),
      chatGateway,
      auditService,
      fallbackReplyComposer,
    );

    const response = await service.answer({
      workspaceId: "workspace-1",
      accountId: "account-1",
      query: "What does this page do?",
      stream: false,
    });

    expect(response.suggestions).toBeUndefined();
  });

  it("adds exploratory suggestions from grounded contexts when the direct answer stays terse", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = {
      async run() {
        return {
          rewrittenQuery: "who is mahiya",
          contexts: [
            {
              chunkId: "chunk-1",
              documentId: "doc-1",
              title: "Mahiya",
              content: "Mahiya is a teacher and author.",
            },
            {
              chunkId: "chunk-2",
              documentId: "doc-2",
              title: "God is our True Home: In Conversation with Mahiya - Ananda Europe",
              content: "An interview about Mahiya's path and spiritual life.",
            },
            {
              chunkId: "chunk-3",
              documentId: "doc-3",
              title: "Il gusto della gioia - Ananda Edizioni - ricette, consigli e ispirazioni salutari",
              content: "Her cooking book and related work.",
            },
            {
              chunkId: "chunk-4",
              documentId: "doc-4",
              title: "Challenges and blessings go hand in hand - Interview with Mahiya (ENG) - Ananda Europe",
              content: "Another interview with adjacent material.",
            },
          ],
          prompt: "prompt text",
          citations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Mahiya" }],
          diagnostics: {
            rewriteStatus: "skipped",
            rerankStatus: "skipped",
            originalCandidateCount: 4,
            rewrittenCandidateCount: 0,
            lexicalCandidateCount: 4,
            normalizedCandidateCount: 4,
            finalContextCount: 4,
            candidateFallbackApplied: false,
            fallbackApplied: false,
            parsedQuery: {
              semanticQuery: "who is mahiya",
              lexicalQuery: "mahiya",
              constraints: [],
            },
          },
          responseSettings: {
            citationDisplayEnabled: true,
          },
        };
      },
    } as const;
    const chatGateway: ChatGateway = {
      async answer({ systemPrompt }) {
        const answerText = "Mahiya is a teacher and author[[1]].";
        if (systemPrompt?.includes("Output envelope")) {
          return envelope(answerText, [
            { text: "What does the interview say about Mahiya's spiritual path?", kind: "deeper", contextIndex: 1 },
            { text: "Which books or projects is Mahiya associated with?", kind: "broader", contextIndex: 2 },
            { text: "What challenges does Mahiya describe in the other interview?", kind: "broader", contextIndex: 3 },
          ]);
        }
        return answerText;
      },
      async *streamAnswer() {
        yield "Mahiya is a teacher and author[[1]].";
      },
    };
    const service = makeChatService(
      conversationRepository,
      messageRepository,
      new RetrievalTurnController(asChatActivityPipeline(retrievalPipeline) as never),
      chatGateway,
      auditService,
      fallbackReplyComposer,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      groundedSkillCapabilities,
    );

    const response = await service.answer({
      workspaceId: "workspace-1",
      accountId: "account-1",
      query: "Who is Mahiya?",
      stream: false,
    });

    expect(response.answer).toEqual(expect.any(String));
    expect(response.answer.length).toBeGreaterThan(0);
    expect(response.answer).not.toContain("\n- ");
    expect(response.suggestions).toEqual([
      expect.objectContaining({
        text: expect.any(String),
        kind: "deeper",
        citation: expect.objectContaining({
          documentId: "doc-1",
        }),
      }),
      expect.objectContaining({
        text: expect.any(String),
        kind: "broader",
      }),
      expect.objectContaining({
        text: expect.any(String),
        kind: "broader",
      }),
    ]);
    expect(response.citations).toEqual([
      { documentId: "doc-1", chunkId: "chunk-1", title: "Mahiya" },
    ]);
  });

  it("streams the answer before emitting grounded follow-up suggestions", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = {
      async run() {
        return {
          rewrittenQuery: "who is mahiya",
          contexts: [
            {
              chunkId: "chunk-1",
              documentId: "doc-1",
              title: "Mahiya",
              content: "Mahiya is a teacher and author.",
            },
            {
              chunkId: "chunk-2",
              documentId: "doc-2",
              title: "Mahiya interview",
              content: "An interview about Mahiya's spiritual path.",
            },
          ],
          prompt: "prompt text",
          citations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Mahiya" }],
          diagnostics: {
            rewriteStatus: "skipped",
            rerankStatus: "skipped",
            originalCandidateCount: 2,
            rewrittenCandidateCount: 0,
            lexicalCandidateCount: 2,
            normalizedCandidateCount: 2,
            finalContextCount: 2,
            candidateFallbackApplied: false,
            fallbackApplied: false,
            parsedQuery: {
              semanticQuery: "who is mahiya",
              lexicalQuery: "mahiya",
              constraints: [],
            },
          },
          responseSettings: {
            citationDisplayEnabled: true,
            suggestedQuestionsEnabled: true,
            suggestedQuestionsCount: 2,
          },
        };
      },
    } as const;
    const chatGateway: ChatGateway = {
      async answer({ systemPrompt }) {
        const answerText = "Mahiya is a teacher and author[[1]].";
        if (systemPrompt?.includes("Output envelope")) {
          return envelope(answerText, [
            { text: "What does the interview say about Mahiya's spiritual path?", contextIndex: 1 },
          ]);
        }
        return answerText;
      },
      async *streamAnswer() {
        yield envelope("Mahiya is a teacher and author[[1]].", [
          { text: "What does the interview say about Mahiya's spiritual path?", contextIndex: 1 },
        ]);
      },
    };
    const service = makeChatService(
      conversationRepository,
      messageRepository,
      new RetrievalTurnController(asChatActivityPipeline(retrievalPipeline) as never),
      chatGateway,
      auditService,
      fallbackReplyComposer,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      groundedSkillCapabilities,
    );

    const events: ChatStreamEvent[] = [];

    for await (const event of service.streamAnswer({
      workspaceId: "workspace-1",
      accountId: "account-1",
      query: "Who is Mahiya?",
      stream: true,
    })) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual(["conversation", "chunk", "done", "suggestions"]);
    expect(events[2]).toMatchObject({
      type: "done",
      answer: "Mahiya is a teacher and author.",
      suggestions: undefined,
    });
    expect(events[3]).toMatchObject({
      type: "suggestions",
      suggestions: [
        {
          text: "What does the interview say about Mahiya's spiritual path?",
          citation: {
            documentId: "doc-1",
            chunkId: "chunk-1",
            title: "Mahiya",
          },
        },
      ],
    });
  });

  it("does not convert a completed answer into a failure when lazy suggestions fail", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditEventRepository = new InMemoryAuditEventRepository();
    const auditService = createAuditService(auditEventRepository);
    const retrievalPipeline = {
      async run() {
        return {
          rewrittenQuery: "who is mahiya",
          contexts: [
            {
              chunkId: "chunk-1",
              documentId: "doc-1",
              title: "Mahiya",
              content: "Mahiya is a teacher and author.",
            },
          ],
          prompt: "prompt text",
          citations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Mahiya" }],
          diagnostics: {
            rewriteStatus: "skipped",
            rerankStatus: "skipped",
            originalCandidateCount: 1,
            rewrittenCandidateCount: 0,
            lexicalCandidateCount: 1,
            normalizedCandidateCount: 1,
            finalContextCount: 1,
            candidateFallbackApplied: false,
            fallbackApplied: false,
            parsedQuery: {
              semanticQuery: "who is mahiya",
              lexicalQuery: "mahiya",
              constraints: [],
            },
          },
          responseSettings: {
            citationDisplayEnabled: true,
            suggestedQuestionsEnabled: true,
            suggestedQuestionsCount: 2,
          },
        };
      },
    } as const;
    const chatGateway: ChatGateway = {
      async answer() {
        // Plain text instead of a valid JSON envelope — exercises the parser's
        // tolerant fallback (answer is preserved, suggestions are empty).
        return "Mahiya is a teacher and author[[1]].";
      },
      async *streamAnswer() {
        yield "Mahiya is a teacher and author[[1]].";
      },
    };
    const service = makeChatService(
      conversationRepository,
      messageRepository,
      new RetrievalTurnController(asChatActivityPipeline(retrievalPipeline) as never),
      chatGateway,
      auditService,
      fallbackReplyComposer,
    );

    const events: ChatStreamEvent[] = [];

    for await (const event of service.streamAnswer({
      workspaceId: "workspace-1",
      accountId: "account-1",
      query: "Who is Mahiya?",
      stream: true,
    })) {
      events.push(event);
    }

    expect(events[0]?.type).toBe("conversation");
    expect(events.at(-1)?.type).toBe("done");
    expect(events.filter((event) => event.type === "chunk").length).toBeGreaterThan(0);
    expect(events.some((event) => event.type === "suggestions")).toBe(false);
    expect(auditEventRepository.items.filter((event) => event.eventType === "chat.answer")).toHaveLength(1);
    expect(auditEventRepository.items[0]?.eventStatus).toBe("success");
  });

  it("returns exploratory suggestions as structured multilingual continuations", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = {
      async run() {
        return {
          rewrittenQuery: "quali libri ha scritto narayani",
          contexts: [
            {
              chunkId: "chunk-1",
              documentId: "doc-1",
              title: "Narayani Anaya Archivi - Ananda Edizioni",
              content: "Narayani wrote La mia anima ricorda Swami Kriyananda.",
            },
            {
              chunkId: "chunk-2",
              documentId: "doc-2",
              title: "Satsang with Narayani (on her upcoming book and more) &mdash; Ananda",
              content: "An event about her upcoming book and more.",
            },
          ],
          prompt: "prompt text",
          citations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Narayani Anaya Archivi - Ananda Edizioni" }],
          diagnostics: {
            rewriteStatus: "skipped",
            rerankStatus: "skipped",
            originalCandidateCount: 2,
            rewrittenCandidateCount: 0,
            lexicalCandidateCount: 2,
            normalizedCandidateCount: 2,
            finalContextCount: 2,
            candidateFallbackApplied: false,
            fallbackApplied: false,
            parsedQuery: {
              semanticQuery: "quali libri ha scritto narayani",
              lexicalQuery: "narayani libri",
              constraints: [],
            },
          },
          responseSettings: {
            citationDisplayEnabled: true,
          },
        };
      },
    } as const;
    const chatGateway: ChatGateway = {
      async answer({ systemPrompt }) {
        const answerText = "Narayani ha scritto La mia anima ricorda Swami Kriyananda[[1]].";
        if (systemPrompt?.includes("Output envelope")) {
          return envelope(answerText, [
            { text: "Quale altro libro o progetto è collegato a Narayani?", kind: "broader", contextIndex: 1 },
          ]);
        }
        return answerText;
      },
      async *streamAnswer() {
        yield "Narayani ha scritto La mia anima ricorda Swami Kriyananda[[1]].";
      },
    };
    const service = makeChatService(
      conversationRepository,
      messageRepository,
      new RetrievalTurnController(asChatActivityPipeline(retrievalPipeline) as never),
      chatGateway,
      auditService,
      fallbackReplyComposer,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      groundedSkillCapabilities,
    );

    const response = await service.answer({
      workspaceId: "workspace-1",
      accountId: "account-1",
      query: "quali libri ha scritto Narayani",
      stream: false,
    });

    expect(response.answer).toEqual(expect.any(String));
    expect(response.answer.length).toBeGreaterThan(0);
    expect(response.suggestions).toEqual([
      expect.objectContaining({
        text: expect.any(String),
        kind: "broader",
        citation: expect.objectContaining({
          documentId: "doc-1",
        }),
      }),
    ]);
  });

  it("filters suggestions that paraphrase the user query", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = {
      async run() {
        return {
          rewrittenQuery: "want links to the next page of assisi videos",
          contexts: [
            {
              chunkId: "chunk-1",
              documentId: "doc-1",
              title: "Assisi Archives - Page 2 of 14 - Ananda Europe",
              content: "Page 2 links to the next page in the archive.",
            },
            {
              chunkId: "chunk-2",
              documentId: "doc-2",
              title: "Assisi Archives - Page 3 of 14 - Ananda Europe",
              content: "Page 3 is part of a 14-page archive.",
            },
          ],
          prompt: "prompt text",
          citations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Assisi Archives - Page 2 of 14 - Ananda Europe" }],
          diagnostics: {
            rewriteStatus: "skipped",
            rerankStatus: "skipped",
            originalCandidateCount: 2,
            rewrittenCandidateCount: 0,
            lexicalCandidateCount: 2,
            normalizedCandidateCount: 2,
            finalContextCount: 2,
            candidateFallbackApplied: false,
            fallbackApplied: false,
            parsedQuery: {
              semanticQuery: "assisi videos next page",
              lexicalQuery: "assisi videos page 3",
              constraints: [],
            },
          },
          responseSettings: {
            citationDisplayEnabled: true,
          },
        };
      },
    } as const;
    const chatGateway: ChatGateway = {
      async answer({ systemPrompt }) {
        const answerText = "Yes — here's the next page of the Assisi videos archive: https://anandaeurope.org/category/video-from-assisi/page/3/[[1]]";
        if (systemPrompt?.includes("Output envelope")) {
          return envelope(answerText, [
            // Near-paraphrase of the user's query — should be filtered.
            { text: "Where are the next Assisi videos links?", kind: "deeper", contextIndex: 2 },
            // Legitimate adjacent angle — should survive even though it shares
            // topic vocabulary ("Assisi", "archive") with the answer.
            { text: "How many Assisi archive pages are there?", kind: "broader", contextIndex: 2 },
          ]);
        }
        return answerText;
      },
      async *streamAnswer() {
        yield "Yes — here's the next page of the Assisi videos archive: https://anandaeurope.org/category/video-from-assisi/page/3/[[1]]";
      },
    };
    const service = makeChatService(
      conversationRepository,
      messageRepository,
      new RetrievalTurnController(asChatActivityPipeline(retrievalPipeline) as never),
      chatGateway,
      auditService,
      fallbackReplyComposer,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      groundedSkillCapabilities,
    );

    const response = await service.answer({
      workspaceId: "workspace-1",
      accountId: "account-1",
      query: "Want links to the next page of Assisi videos?",
      stream: false,
    });

    expect(response.suggestions).toEqual([
      expect.objectContaining({
        text: expect.any(String),
        kind: "broader",
        citation: expect.objectContaining({
          documentId: "doc-2",
        }),
      }),
    ]);
  });

  it("feeds recent conversation context into exploratory suggestion planning", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = {
      async run({ query }: { query: string }) {
        return {
          rewrittenQuery: query.toLowerCase(),
          contexts: [
            {
              chunkId: "chunk-1",
              documentId: "doc-1",
              title: "Retreat Planning Guide",
              content: "A beginner retreat should cover meditation, schedule planning, meals, and orientation.",
            },
            {
              chunkId: "chunk-2",
              documentId: "doc-2",
              title: "Retreat Facilitation Notes",
              content: "Facilitators should balance logistics, teaching goals, and attendee support.",
            },
          ],
          prompt: "prompt text",
          citations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Retreat Planning Guide" }],
          diagnostics: {
            rewriteStatus: "skipped",
            rerankStatus: "skipped",
            originalCandidateCount: 2,
            rewrittenCandidateCount: 0,
            lexicalCandidateCount: 2,
            normalizedCandidateCount: 2,
            finalContextCount: 2,
            candidateFallbackApplied: false,
            fallbackApplied: false,
            parsedQuery: {
              semanticQuery: query.toLowerCase(),
              lexicalQuery: query.toLowerCase(),
              constraints: [],
            },
          },
          responseSettings: {
            citationDisplayEnabled: true,
          },
        };
      },
    } as const;
    const chatGateway: ChatGateway = {
      async answer({ systemPrompt, query }) {
        const answerText =
          query === "What should I include next?"
            ? "You should include orientation and meals[[1]]."
            : "Start with a beginner retreat schedule[[1]].";
        if (systemPrompt?.includes("Output envelope")) {
          return envelope(answerText, [
            { text: "What should a beginner retreat schedule include?", kind: "deeper", contextIndex: 1 },
            { text: "How should retreat facilitators support attendees?", kind: "broader", contextIndex: 2 },
          ]);
        }
        return answerText;
      },
      async *streamAnswer() {
        yield "";
      },
    };
    const service = makeChatService(
      conversationRepository,
      messageRepository,
      new RetrievalTurnController(asChatActivityPipeline(retrievalPipeline) as never),
      chatGateway,
      auditService,
      fallbackReplyComposer,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      groundedSkillCapabilities,
    );

    const first = await service.answer({
      workspaceId: "workspace-1",
      accountId: "account-1",
      query: "Help me plan a beginner retreat",
      stream: false,
    });
    const second = await service.answer({
      workspaceId: "workspace-1",
      accountId: "account-1",
      conversationId: first.conversationId,
      query: "What should I include next?",
      stream: false,
    });

    expect(second.suggestions).toEqual([
      expect.objectContaining({
        text: expect.any(String),
        kind: "deeper",
        citation: expect.objectContaining({
          documentId: "doc-1",
        }),
      }),
      expect.objectContaining({
        text: expect.any(String),
        kind: "broader",
        citation: expect.objectContaining({
          documentId: "doc-2",
        }),
      }),
    ]);
  });

  it("recenters exploratory planning when the user explicitly pivots subjects", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = {
      async run({ query }: { query: string }) {
        const pivotTurn = query === "What about facilitator support?";
        return {
          rewrittenQuery: pivotTurn ? "facilitator support" : "plan a beginner retreat",
          contexts: pivotTurn
            ? [
                {
                    chunkId: "chunk-2",
                    documentId: "doc-2",
                    title: "Retreat Facilitation Notes",
                    content: "Facilitators should balance logistics, teaching goals, and attendee support.",
                },
                {
                    chunkId: "chunk-3",
                    documentId: "doc-3",
                    title: "Retreat Support Roles",
                    content: "Support roles include hospitality, orientation, and attendee care.",
                },
              ]
            : [
                {
                    chunkId: "chunk-1",
                    documentId: "doc-1",
                    title: "Retreat Planning Guide",
                    content: "A beginner retreat should cover meditation, schedule planning, meals, and orientation.",
                },
                {
                    chunkId: "chunk-2",
                    documentId: "doc-2",
                    title: "Retreat Facilitation Notes",
                    content: "Facilitators should balance logistics, teaching goals, and attendee support.",
                },
              ],
          prompt: "prompt text",
          citations: [
            pivotTurn
              ? { documentId: "doc-2", chunkId: "chunk-2", title: "Retreat Facilitation Notes" }
              : { documentId: "doc-1", chunkId: "chunk-1", title: "Retreat Planning Guide" },
          ],
          diagnostics: {
            rewriteStatus: "applied",
            rerankStatus: "skipped",
            originalCandidateCount: 2,
            rewrittenCandidateCount: 1,
            lexicalCandidateCount: 2,
            normalizedCandidateCount: 2,
            finalContextCount: 2,
            candidateFallbackApplied: false,
            fallbackApplied: false,
            parsedQuery: {
              semanticQuery: query.toLowerCase(),
              lexicalQuery: query.toLowerCase(),
              constraints: [],
            },
            rewriteProposal: pivotTurn
              ? {
                  rewrittenQuery: "facilitator support",
                  semanticQuery: "facilitator support retreat attendees",
                  lexicalQuery: "facilitator support",
                  turnKind: "explicit_recenter",
                  proposedActiveSubject: "Facilitator support",
                  relatedEntities: [],
                  unresolved: false,
                  confidence: 0.97,
                }
              : {
                  rewrittenQuery: "plan a beginner retreat",
                  semanticQuery: "beginner retreat planning",
                  lexicalQuery: "beginner retreat planning",
                  turnKind: "fresh_subject",
                  proposedActiveSubject: "Beginner retreat planning",
                  relatedEntities: [],
                  unresolved: false,
                  confidence: 0.94,
                },
          },
          responseSettings: {
            citationDisplayEnabled: true,
          },
        };
      },
    } as const;
    const chatGateway: ChatGateway = {
      async answer({ systemPrompt, query }) {
        const answerText =
          query === "What about facilitator support?"
            ? "Facilitators should balance logistics and attendee care[[1]]."
            : "Start with a beginner retreat schedule[[1]].";
        if (systemPrompt?.includes("Output envelope")) {
          if (systemPrompt.includes("Active subject:\nFacilitator support")) {
            return envelope(answerText, [
              { text: "How should facilitators support retreat attendees?", kind: "deeper", contextIndex: 1 },
              { text: "Which support roles should back up retreat facilitators?", kind: "broader", contextIndex: 2 },
            ]);
          }
          return envelope(answerText, [
            { text: "What should a beginner retreat schedule include?", kind: "deeper", contextIndex: 1 },
            { text: "How should retreat facilitators support attendees?", kind: "broader", contextIndex: 2 },
          ]);
        }
        return answerText;
      },
      async *streamAnswer() {
        yield "";
      },
    };
    const service = makeChatService(
      conversationRepository,
      messageRepository,
      new RetrievalTurnController(asChatActivityPipeline(retrievalPipeline) as never),
      chatGateway,
      auditService,
      fallbackReplyComposer,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      groundedSkillCapabilities,
    );

    const first = await service.answer({
      workspaceId: "workspace-1",
      accountId: "account-1",
      query: "Help me plan a beginner retreat",
      stream: false,
    });
    const second = await service.answer({
      workspaceId: "workspace-1",
      accountId: "account-1",
      conversationId: first.conversationId,
      query: "What about facilitator support?",
      stream: false,
    });

    expect(second.suggestions).toEqual([
      expect.objectContaining({
        text: expect.any(String),
        kind: "deeper",
        citation: expect.objectContaining({
          documentId: "doc-2",
        }),
      }),
      expect.objectContaining({
        text: expect.any(String),
        kind: "broader",
        citation: expect.objectContaining({
          documentId: "doc-3",
        }),
      }),
    ]);
  });

  it("does not suppress exploratory suggestions from language-specific directness wording", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = {
      async run() {
        return {
          rewrittenQuery: "just the answer what does the guide cover",
          contexts: [
            {
              chunkId: "chunk-1",
              documentId: "doc-1",
              title: "Guide",
              content: "The guide covers testing, onboarding, and parser rules.",
            },
          ],
          prompt: "prompt text",
          citations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Guide" }],
          diagnostics: {
            rewriteStatus: "skipped",
            rerankStatus: "skipped",
            originalCandidateCount: 1,
            rewrittenCandidateCount: 0,
            lexicalCandidateCount: 1,
            normalizedCandidateCount: 1,
            finalContextCount: 1,
            candidateFallbackApplied: false,
            fallbackApplied: false,
            parsedQuery: {
              semanticQuery: "guide cover",
              lexicalQuery: "guide cover",
              constraints: [],
            },
          },
          responseSettings: {
            citationDisplayEnabled: true,
          },
        };
      },
    } as const;
    let suggestionCallCount = 0;
    const chatGateway: ChatGateway = {
      async answer({ systemPrompt }) {
        const answerText = "The guide covers testing, onboarding, and parser rules[[1]].";
        if (systemPrompt?.includes("Output envelope")) {
          suggestionCallCount += 1;
          return envelope(answerText, [
            { text: "How should teams apply these rules?", kind: "deeper", contextIndex: 1 },
            { text: "What setup examples are available?", kind: "deeper", contextIndex: 1 },
            { text: "Which workflow risks should I compare?", kind: "broader", contextIndex: 1 },
          ]);
        }
        return answerText;
      },
      async *streamAnswer() {
        yield "";
      },
    };
    const service = makeChatService(
      conversationRepository,
      messageRepository,
      new RetrievalTurnController(asChatActivityPipeline(retrievalPipeline) as never),
      chatGateway,
      auditService,
      fallbackReplyComposer,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      groundedSkillCapabilities,
    );

    const response = await service.answer({
      workspaceId: "workspace-1",
      accountId: "account-1",
      query: "Just the answer: what does the guide cover?",
      stream: false,
    });

    expect(suggestionCallCount).toBe(1);
    expect(response.suggestions).toEqual([
      expect.objectContaining({
        text: "How should teams apply these rules?",
        kind: "deeper",
      }),
      expect.objectContaining({
        text: "What setup examples are available?",
        kind: "deeper",
      }),
      expect.objectContaining({
        text: "Which workflow risks should I compare?",
        kind: "broader",
      }),
    ]);
  });

  it("drops invalid grouped suggestions and removes duplicates across lanes", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = {
      async run() {
        return {
          rewrittenQuery: "what does the archive cover",
          contexts: [
            {
              chunkId: "chunk-1",
              documentId: "doc-1",
              title: "Archive Guide",
              content: "The archive covers videos, audio, and retreat notes.",
            },
            {
              chunkId: "chunk-2",
              documentId: "doc-2",
              title: "Archive Notes",
              content: "The notes explain how the archive is organized.",
            },
          ],
          prompt: "prompt text",
          citations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Archive Guide" }],
          diagnostics: {
            rewriteStatus: "skipped",
            rerankStatus: "skipped",
            originalCandidateCount: 2,
            rewrittenCandidateCount: 0,
            lexicalCandidateCount: 2,
            normalizedCandidateCount: 2,
            finalContextCount: 2,
            candidateFallbackApplied: false,
            fallbackApplied: false,
            parsedQuery: {
              semanticQuery: "archive cover",
              lexicalQuery: "archive cover",
              constraints: [],
            },
          },
          responseSettings: {
            citationDisplayEnabled: true,
          },
        };
      },
    } as const;
    const chatGateway: ChatGateway = {
      async answer({ systemPrompt }) {
        const answerText = "The archive covers videos, audio, and retreat notes[[1]].";
        if (systemPrompt?.includes("Output envelope")) {
          return envelope(answerText, [
            { text: "What does the archive cover?", kind: "deeper", contextIndex: 1 },
            { text: "How is the archive organized?", kind: "broader", contextIndex: 2 },
            { text: "How is the archive organized?", kind: "deeper", contextIndex: 2 },
            { text: "Which archive videos are available?", kind: "invalid_kind", contextIndex: 1 },
          ]);
        }
        return answerText;
      },
      async *streamAnswer() {
        yield "";
      },
    };
    const service = makeChatService(
      conversationRepository,
      messageRepository,
      new RetrievalTurnController(asChatActivityPipeline(retrievalPipeline) as never),
      chatGateway,
      auditService,
      fallbackReplyComposer,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      groundedSkillCapabilities,
    );

    const response = await service.answer({
      workspaceId: "workspace-1",
      accountId: "account-1",
      query: "What does the archive cover?",
      stream: false,
    });

    expect(response.suggestions).toEqual([
      expect.objectContaining({
        text: expect.any(String),
        kind: "broader",
        citation: expect.objectContaining({
          documentId: "doc-2",
        }),
      }),
    ]);
  });

  it("preserves a broader lane when valid broader suggestions arrive after deeper ones", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = {
      async run() {
        return {
          rewrittenQuery: "retreat planning",
          contexts: [
            {
              chunkId: "chunk-1",
              documentId: "doc-1",
              title: "Retreat Planning Guide",
              content: "The guide covers schedules, meals, and orientation.",
            },
            {
              chunkId: "chunk-2",
              documentId: "doc-2",
              title: "Retreat Meal Guide",
              content: "Meals should fit the retreat schedule and attendee needs.",
            },
            {
              chunkId: "chunk-3",
              documentId: "doc-3",
              title: "Retreat Orientation Guide",
              content: "Orientation should set expectations and welcome attendees.",
            },
            {
              chunkId: "chunk-4",
              documentId: "doc-4",
              title: "Retreat Facilitation Notes",
              content: "Facilitators should support attendee logistics and questions.",
            },
          ],
          prompt: "prompt text",
          citations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Retreat Planning Guide" }],
          diagnostics: {
            rewriteStatus: "skipped",
            rerankStatus: "skipped",
            originalCandidateCount: 4,
            rewrittenCandidateCount: 0,
            lexicalCandidateCount: 4,
            normalizedCandidateCount: 4,
            finalContextCount: 4,
            candidateFallbackApplied: false,
            fallbackApplied: false,
            parsedQuery: {
              semanticQuery: "retreat planning",
              lexicalQuery: "retreat planning",
              constraints: [],
            },
          },
          responseSettings: {
            citationDisplayEnabled: true,
            suggestedQuestionsCount: 3,
          },
        };
      },
    } as const;
    const chatGateway: ChatGateway = {
      async answer({ systemPrompt }) {
        const answerText = "Start with the retreat schedule and day-one orientation[[1]].";
        if (systemPrompt?.includes("Output envelope")) {
          return envelope(answerText, [
            { text: "What should the retreat schedule include?", kind: "deeper", contextIndex: 1 },
            { text: "How should retreat meals fit the schedule?", kind: "deeper", contextIndex: 2 },
            { text: "What should orientation cover on day one?", kind: "deeper", contextIndex: 3 },
            { text: "How should facilitators support retreat attendees?", kind: "broader", contextIndex: 4 },
          ]);
        }
        return answerText;
      },
      async *streamAnswer() {
        yield "";
      },
    };
    const service = makeChatService(
      conversationRepository,
      messageRepository,
      new RetrievalTurnController(asChatActivityPipeline(retrievalPipeline) as never),
      chatGateway,
      auditService,
      fallbackReplyComposer,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      groundedSkillCapabilities,
    );

    const response = await service.answer({
      workspaceId: "workspace-1",
      accountId: "account-1",
      query: "Help me plan a retreat",
      stream: false,
    });

    expect(response.suggestions).toEqual([
      expect.objectContaining({
        text: expect.any(String),
        kind: "deeper",
        citation: expect.objectContaining({
          documentId: "doc-1",
        }),
      }),
      expect.objectContaining({
        text: expect.any(String),
        kind: "broader",
        citation: expect.objectContaining({
          documentId: "doc-4",
        }),
      }),
      expect.objectContaining({
        text: expect.any(String),
        kind: "deeper",
        citation: expect.objectContaining({
          documentId: "doc-2",
        }),
      }),
    ]);
  });

  it("preserves grounded markdown links while attaching implicit citations", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = {
      async run() {
        return {
          rewrittenQuery: "where can i read more",
          contexts: [
            {
              chunkId: "chunk-1",
              documentId: "doc-1",
              title: "Guide",
              content: "The page explains testing and parsing content for users.",
              metadata: {
                sourceUrl: "https://example.com/guide",
              },
            },
          ],
          prompt: "prompt text",
          citations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Guide" }],
          diagnostics: {
            rewriteStatus: "skipped",
            rerankStatus: "skipped",
            originalCandidateCount: 1,
            rewrittenCandidateCount: 0,
            lexicalCandidateCount: 1,
            normalizedCandidateCount: 1,
            finalContextCount: 1,
            candidateFallbackApplied: false,
            fallbackApplied: false,
            parsedQuery: {
              semanticQuery: "read more",
              lexicalQuery: "read more",
              constraints: [],
            },
          },
          responseSettings: {
            citationDisplayEnabled: true,
          },
        };
      },
    } as const;
    const chatGateway: ChatGateway = {
      async answer() {
        return "Read more here: [Guide](https://example.com/guide). It explains testing and parsing content for users.";
      },
      async *streamAnswer() {
        yield "";
      },
    };
    const service = makeChatService(
      conversationRepository,
      messageRepository,
      new RetrievalTurnController(asChatActivityPipeline(retrievalPipeline) as never),
      chatGateway,
      auditService,
      fallbackReplyComposer,
    );

    const response = await service.answer({
      workspaceId: "workspace-1",
      query: "Where can I read more?",
      stream: false,
    });

    expect(response.answer).toEqual(expect.any(String));
    expect(response.answer).toContain("Guide");
    expect(response.citations).toEqual([
      {
        documentId: "doc-1",
        chunkId: "chunk-1",
        title: "Guide",
        sourceUrl: "https://example.com/guide",
      },
    ]);
    expect(response.answerSegments).toEqual([
      {
        text: expect.any(String),
      },
      {
        text: "It explains testing and parsing content for users.",
        citationIndices: [0],
      },
    ]);
  });

  it("routes social-only turns through the non-retrieval path and keeps answer instructions available", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    let groundedMissCalls = 0;
    let observedPrompt = "";
    let runInterpretedCalls = 0;
    let runWithoutRetrievalCalls = 0;

    const retrievalPipeline = {
      async run() {
        throw new Error("run should not be used when intent routing is available");
      },
      async interpret() {
        return {
          request: {
            workspaceId: "workspace-1",
            query: "Thanks for the help",
            history: [],
            responseIdentity: {
              name: "Vikram",
            },
          },
          traceStartedAtMs: Date.now(),
          context: {
            startedAt: Date.now(),
            durationMs: 1,
            result: {
              request: {
                workspaceId: "workspace-1",
                query: "Thanks for the help",
                history: [],
                responseIdentity: {
                  name: "Vikram",
                },
              },
              settings: {
                workspaceId: "workspace-1",
                queryRewriteEnabled: true,
                semanticRewriteInstructions: "",
                lexicalRewriteInstructions: "",
                suggestedQuestionsEnabled: true,
                suggestedQuestionsCount: 3,
                rerankEnabled: false,
                vectorTopK: 20,
                similarityThreshold: 0.1,
                rerankTopK: 5,
                citationDisplayEnabled: true,
                customInstruction: "Keep the tone calm and welcoming.",
                metadataRules: [],
                createdAt: new Date(),
                updatedAt: new Date(),
              },
              contextWindow: {
                selectedMessages: [],
                truncated: false,
                selectionReason: "full-history",
              },
            },
          },
          interpretation: {
            startedAt: Date.now(),
            durationMs: 1,
            result: {
              responseIntent: "social_only",
            },
          },
        };
      },
      async runInterpreted() {
        runInterpretedCalls += 1;
        throw new Error("runInterpreted should not be used for social-only turns");
      },
      async runWithoutRetrieval() {
        runWithoutRetrievalCalls += 1;
        return {
          rewrittenQuery: "Thanks for the help",
          contexts: [],
          prompt: "",
          citations: [],
          responseIdentity: {
            name: "Vikram",
          },
          responseSettings: {
            citationDisplayEnabled: true,
            suggestedQuestionsEnabled: true,
            suggestedQuestionsCount: 3,
            customInstruction: "Keep the tone calm and welcoming.",
            responseLanguagePolicy: "match_user_question",
          },
          diagnostics: {
            rewriteStatus: "applied",
            rerankStatus: "skipped",
            originalCandidateCount: 0,
            rewrittenCandidateCount: 0,
            lexicalCandidateCount: 0,
            normalizedCandidateCount: 0,
            finalContextCount: 0,
            candidateFallbackApplied: false,
            fallbackApplied: false,
            responseIntent: "social_only",
            retrievalSkipped: true,
            intentConfidence: 0.96,
            intentFallbackApplied: false,
            parsedQuery: {
              originalQuery: "Thanks for the help",
              semanticQuery: "Thanks for the help",
              lexicalQuery: "Thanks for the help",
              constraints: [],
            },
            triggerAnalysis: {
              status: "skipped_non_retrieval",
              consideredRules: [],
              matchedRuleIds: [],
              unmatchedRuleIds: [],
              matchCount: 0,
              matcherVersion: "non_retrieval",
            },
          },
          trace: {
            traceId: "trace-1",
            startedAt: new Date().toISOString(),
            stages: [
              { stageId: "diagnostics", kind: "diagnostics", label: "Diagnostics", status: "skipped" },
            ],
            links: [],
          },
        };
      },
    } as const;
    const chatGateway: ChatGateway = {
      async answer({ prompt }) {
        observedPrompt = prompt;
        return "Thanks. Ask me about retreats or courses when you're ready.";
      },
      async *streamAnswer() {
        yield "unused";
      },
    };
    const fallbackComposer: FallbackReplyComposer = {
      async composeNoContext() {
        groundedMissCalls += 1;
        return "I couldn't find supporting material.";
      },
    };
    const service = makeChatService(
      conversationRepository,
      messageRepository,
      new RetrievalTurnController(asChatActivityPipeline(retrievalPipeline) as never),
      chatGateway,
      auditService,
      fallbackComposer,
    );

    const response = await service.answer({
      workspaceId: "workspace-1",
      query: "Thanks for the help",
      stream: false,
    });

    expect(response.answer).toBe("Thanks. Ask me about retreats or courses when you're ready.");
    expect(response.route).toEqual({
      type: "direct",
      reason: "social_only",
    });
    expect(response.citations).toBeUndefined();
    expect(response.activitySummary).toMatchObject({
      responseIntent: "social_only",
      retrievalSkipped: true,
      intentConfidence: 0.96,
    });
    expect(response.activityTrace.stages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stageId: "answer",
          status: "applied",
          outputs: expect.objectContaining({
            retrievalSkipped: true,
          }),
        }),
      ]),
    );
    expect(observedPrompt).toContain("Keep the tone calm and welcoming.");
    expect(observedPrompt).toContain("Stable assistant identity:");
    expect(observedPrompt).toContain("Vikram");
    expect(groundedMissCalls).toBe(0);
    expect(runWithoutRetrievalCalls).toBe(1);
    expect(runInterpretedCalls).toBe(0);
    expect(auditService.events).toContainEqual(
      expect.objectContaining({
        eventType: "chat.answer",
        eventStatus: "success",
        metadata: expect.objectContaining({
          answerOutcome: "non_retrieval_response",
          route: expect.objectContaining({
            generator: "assistant",
            routeType: "direct",
            routeReason: "social_only",
            retrievalInvoked: false,
          }),
        }),
      }),
    );
    const socialMessages = await messageRepository.listByConversationId("workspace-1", response.conversationId);
    expect(socialMessages.find((message) => message.role === "assistant")?.skillName).toBe("social_only.answer");
  });

  it("routes assistant-identity turns through the same non-retrieval path without regex checks", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    let observedPrompt = "";

    const retrievalPipeline = {
      async run() {
        throw new Error("run should not be used when intent routing is available");
      },
      async interpret() {
        return {
          request: {
            workspaceId: "workspace-1",
            query: "Remind me what you do around here",
            history: [],
            responseIdentity: {
              name: "Vikram",
            },
          },
          traceStartedAtMs: Date.now(),
          context: {
            startedAt: Date.now(),
            durationMs: 1,
            result: {
              request: {
                workspaceId: "workspace-1",
                query: "Remind me what you do around here",
                history: [],
                responseIdentity: {
                  name: "Vikram",
                },
              },
              settings: {
                workspaceId: "workspace-1",
                queryRewriteEnabled: true,
                semanticRewriteInstructions: "",
                lexicalRewriteInstructions: "",
                suggestedQuestionsEnabled: true,
                suggestedQuestionsCount: 3,
                rerankEnabled: false,
                vectorTopK: 20,
                similarityThreshold: 0.1,
                rerankTopK: 5,
                citationDisplayEnabled: true,
                customInstruction: "Keep the reply brief.",
                metadataRules: [],
                createdAt: new Date(),
                updatedAt: new Date(),
              },
              contextWindow: {
                selectedMessages: [],
                truncated: false,
                selectionReason: "full-history",
              },
            },
          },
          interpretation: {
            startedAt: Date.now(),
            durationMs: 1,
            result: {
              responseIntent: "assistant_identity",
            },
          },
        };
      },
      async runInterpreted() {
        throw new Error("runInterpreted should not be used for assistant identity turns");
      },
      async runWithoutRetrieval() {
        return {
          rewrittenQuery: "Remind me what you do around here",
          contexts: [],
          prompt: "",
          citations: [],
          responseIdentity: {
            name: "Vikram",
          },
          responseSettings: {
            citationDisplayEnabled: true,
            suggestedQuestionsEnabled: true,
            suggestedQuestionsCount: 3,
            customInstruction: "Keep the reply brief.",
            responseLanguagePolicy: "match_user_question",
          },
          diagnostics: {
            rewriteStatus: "applied",
            rerankStatus: "skipped",
            originalCandidateCount: 0,
            rewrittenCandidateCount: 0,
            lexicalCandidateCount: 0,
            normalizedCandidateCount: 0,
            finalContextCount: 0,
            candidateFallbackApplied: false,
            fallbackApplied: false,
            responseIntent: "assistant_identity",
            retrievalSkipped: true,
            intentConfidence: 0.9,
            intentFallbackApplied: false,
            parsedQuery: {
              originalQuery: "Remind me what you do around here",
              semanticQuery: "Remind me what you do around here",
              lexicalQuery: "Remind me what you do around here",
              constraints: [],
            },
            triggerAnalysis: {
              status: "skipped_non_retrieval",
              consideredRules: [],
              matchedRuleIds: [],
              unmatchedRuleIds: [],
              matchCount: 0,
              matcherVersion: "non_retrieval",
            },
          },
          trace: {
            traceId: "trace-2",
            startedAt: new Date().toISOString(),
            stages: [
              { stageId: "diagnostics", kind: "diagnostics", label: "Diagnostics", status: "skipped" },
            ],
            links: [],
          },
        };
      },
    } as const;
    const chatGateway: ChatGateway = {
      async answer({ prompt }) {
        observedPrompt = prompt;
        return "I'm Vikram.";
      },
      async *streamAnswer() {
        yield "unused";
      },
    };
    const service = makeChatService(
      conversationRepository,
      messageRepository,
      new RetrievalTurnController(asChatActivityPipeline(retrievalPipeline) as never),
      chatGateway,
      auditService,
      fallbackReplyComposer,
    );

    const response = await service.answer({
      workspaceId: "workspace-1",
      query: "Remind me what you do around here",
      stream: false,
    });

    expect(response.answer).toBe("I'm Vikram.");
    expect(response.route).toEqual({
      type: "direct",
      reason: "assistant_identity",
    });
    expect(response.activitySummary).toMatchObject({
      responseIntent: "assistant_identity",
      retrievalSkipped: true,
    });
    expect(observedPrompt).toContain("Answer Instructions:");
    expect(observedPrompt).toContain("Vikram");
    expect(observedPrompt).toContain("Keep the reply brief.");
    const identityMessages = await messageRepository.listByConversationId("workspace-1", response.conversationId);
    expect(identityMessages.find((message) => message.role === "assistant")?.skillName).toBe("assistant_identity.answer");
  });

  it("adds explicit missing-identity guidance when assistant identity is not configured", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    let observedPrompt = "";
    const retrievalPipeline = createIntentRoutedNoContextPipeline({
      query: "Who are you?",
      responseIntent: "assistant_identity",
    });
    const chatGateway: ChatGateway = {
      async answer({ prompt }) {
        observedPrompt = prompt;
        return "I don't have a configured workspace identity yet.";
      },
      async *streamAnswer() {
        yield "unused";
      },
    };
    const service = makeChatService(
      conversationRepository,
      messageRepository,
      new RetrievalTurnController(asChatActivityPipeline(retrievalPipeline) as never),
      chatGateway,
      auditService,
      fallbackReplyComposer,
    );

    await service.answer({
      workspaceId: "workspace-1",
      query: "Who are you?",
      stream: false,
    });

    expect(observedPrompt).toContain("Identity status: not_configured");
    expect(observedPrompt).toContain("Say that you are the assistant that can answer the user's questions.");
  });

  describe("engine-on vs engine-off streaming parity", () => {
    // #513: streaming routes through the conversation engine when it is wired and
    // through the same selection seam directly otherwise. Both paths wrap the
    // identical terminal-skill streamRender and share getUnstreamedFinalAnswerRemainder,
    // so a turn must stream and finalize byte-identically regardless of the
    // RADIOSO_CONVERSATION_ENGINE_ENABLED flag. These cases pin that invariant —
    // the gate for flipping the flag on in production — across the distinct
    // streaming shapes: a non-retrieval skill, a cited retrieval answer, and a
    // grounded miss that triggers the skill's post-stream reconcile.
    interface ParityCase {
      name: string;
      query: string;
      build: () => {
        retrievalTurn: ChatServiceOptions["retrievalTurn"];
        chatGateway: ChatGateway;
      };
    }

    const groundedRetrievalResult = (content: string) => ({
      rewrittenQuery: "query",
      contexts: [
        {
          chunkId: "chunk-1",
          documentId: "doc-1",
          title: "Source",
          content,
        },
      ],
      prompt: "prompt text",
      citations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Source" }],
      diagnostics: {
        rewriteStatus: "skipped",
        rerankStatus: "skipped",
        originalCandidateCount: 1,
        rewrittenCandidateCount: 0,
        lexicalCandidateCount: 1,
        normalizedCandidateCount: 1,
        finalContextCount: 1,
        candidateFallbackApplied: false,
        fallbackApplied: false,
        parsedQuery: {
          semanticQuery: "query",
          lexicalQuery: "query",
          constraints: [],
        },
      },
      responseSettings: {
        citationDisplayEnabled: true,
      },
    });

    const chunkTextsOf = (events: ChatStreamEvent[]): string[] =>
      events
        .filter((event): event is Extract<ChatStreamEvent, { type: "chunk" }> => event.type === "chunk")
        .map((event) => event.text);

    const stableDoneOf = (events: ChatStreamEvent[]) => {
      const done = events.find(
        (event): event is Extract<ChatStreamEvent, { type: "done" }> => event.type === "done",
      );
      if (!done) {
        throw new Error("stream produced no done event");
      }
      // Content-bearing fields only — conversationId / assistantMessageId are freshly
      // generated per run and must not be compared across configs.
      return {
        answer: done.answer,
        citations: done.citations,
        answerSegments: done.answerSegments,
        suggestions: done.suggestions,
        route: done.route,
      };
    };

    const runStreamedTurn = async (engineOn: boolean, parityCase: ParityCase) => {
      const conversationRepository = new InMemoryConversationRepository();
      const messageRepository = new InMemoryMessageRepository();
      const auditService = createAuditService();
      const { retrievalTurn, chatGateway } = parityCase.build();
      const service = makeChatService(
        conversationRepository,
        messageRepository,
        retrievalTurn,
        chatGateway,
        auditService,
        fallbackReplyComposer,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        engineOn ? createConversationEngine() : undefined,
      );

      const events: ChatStreamEvent[] = [];
      let conversationId = "";
      for await (const event of service.streamAnswer({
        workspaceId: "workspace-1",
        query: parityCase.query,
        stream: true,
      })) {
        events.push(event);
        if (event.type === "conversation") {
          conversationId = event.conversationId;
        }
      }
      const persisted = await messageRepository.listByConversationId("workspace-1", conversationId);
      return {
        chunks: chunkTextsOf(events),
        done: stableDoneOf(events),
        persisted: persisted.map((message) => ({ role: message.role, content: message.content })),
      };
    };

    const parityCases: ParityCase[] = [
      {
        name: "non-retrieval social turn",
        query: "Hi there",
        build: () => ({
          retrievalTurn: new RetrievalTurnController(
            asChatActivityPipeline(
              createIntentRoutedNoContextPipeline({
                query: "Hi there",
                responseIntent: "social_only",
              }),
            ) as never,
          ),
          chatGateway: {
            async answer() {
              return "Hello there! How can I help?";
            },
            async *streamAnswer() {
              yield "Hello there! ";
              yield "How can I help?";
            },
          },
        }),
      },
      {
        name: "retrieval cited multi-chunk answer",
        query: "How should I start meditating?",
        build: () => ({
          retrievalTurn: new RetrievalTurnController(
            asChatActivityPipeline({
              async run() {
                return groundedRetrievalResult(
                  "Keep meditation practice short and simple. Begin with a few minutes each day. Consistency matters more than duration.",
                );
              },
            }) as never,
          ),
          chatGateway: {
            async answer() {
              return "Keep meditation practice short and simple[[1]]. Begin with a few minutes each day. Consistency matters more than duration.";
            },
            async *streamAnswer() {
              yield "Keep meditation practice short and simple[[1]]. ";
              yield "Begin with a few minutes each day. ";
              yield "Consistency matters more than duration.";
              yield `\n${SUGGESTIONS_SENTINEL}\n[]`;
            },
          },
        }),
      },
      {
        name: "retrieval grounded miss reconcile",
        query: "What time does the museum open?",
        build: () => ({
          retrievalTurn: new RetrievalTurnController(
            asChatActivityPipeline({
              async run() {
                return groundedRetrievalResult("Alpha beta gamma delta epsilon zeta eta theta.");
              },
            }) as never,
          ),
          // Streams prose that matches no retrieved context and carries no citation
          // anchor, so the skill's post-stream reconcile swaps in the grounded-miss
          // reply. Both configs must reach that swap identically.
          chatGateway: {
            async answer() {
              return "Completely unrelated prose that cites nothing at all.";
            },
            async *streamAnswer() {
              yield "Completely unrelated prose ";
              yield "that cites nothing at all.";
            },
          },
        }),
      },
    ];

    for (const parityCase of parityCases) {
      it(`streams and finalizes identically with and without the engine: ${parityCase.name}`, async () => {
        const withoutEngine = await runStreamedTurn(false, parityCase);
        const withEngine = await runStreamedTurn(true, parityCase);

        expect(withEngine.chunks).toEqual(withoutEngine.chunks);
        expect(withEngine.done).toEqual(withoutEngine.done);
        expect(withEngine.persisted).toEqual(withoutEngine.persisted);

        // Guard against a vacuous pass: the turn must have produced a real answer and
        // persisted the assistant message.
        expect(withoutEngine.done.answer).toBeTruthy();
        expect(withoutEngine.persisted).toContainEqual(
          expect.objectContaining({ role: "assistant" }),
        );
      });
    }
  });

});
