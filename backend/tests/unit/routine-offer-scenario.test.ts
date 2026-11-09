import { describe, expect, it, vi } from "vitest";

import type {
  ConversationModelGateway,
  PendingClarification,
  RoutineState,
} from "@radioso/conversation-contract";
import { createConversationEngine } from "@radioso/conversation-engine";
import { DefaultClarifier, type RoutineRegistration } from "@radioso/conversation-defaults";

import { createPublishedRoutineRegistrationSource } from "../../src/app/composition/routineDefinitionSource.js";
import type { AgentRevision } from "../../src/modules/agents/agentRevision.js";
import type { ChatGatewayInput } from "../../src/modules/chat/contracts/chatGateway.js";
import { ChatService, type ChatGateway, type ChatRoutineProvider } from "../../src/modules/chat/services/chatService.js";
import { buildChatTurnRuntime } from "../../src/modules/chat/services/chatTurnRuntime.js";
import type { ChatClarificationStore } from "../../src/modules/chat/services/clarification/deferredClarificationStore.js";
import type { FallbackReplyComposer } from "../../src/modules/chat/services/fallbackReplyComposer.js";
import type { RoutineOfferStore } from "../../src/modules/chat/services/routines/deferredRoutineOffer.js";
import { RetrievalTurnController } from "../../src/modules/chat/services/retrievalTurnDispatch.js";
import { compileRoutineDefinition, type RoutineDefinition } from "../../src/modules/routines/public.js";
import { createRoutineTurnProvider } from "../../src/modules/routines/turnProvider.js";
import { DefaultAllowCapabilityPolicy } from "../../src/shared/domain/capabilityPolicy.js";
import { loadPromptTemplate } from "../../src/shared/infra/prompts/promptLoader.js";
import { MetricsRegistry } from "../../src/shared/observability/metrics/metricsRegistry.js";
import {
  createAuditService,
  InMemoryAgentRepository,
  InMemoryConversationRepository,
  InMemoryMessageRepository,
  pinExistingConversationsToPublishedRevisions,
  publishedRevisionResolverFixture,
} from "../support/fakes.js";

/**
 * Real turns through ChatService for an Offer-first routine (#1716): the production routine
 * provider, registry, engine, runner, clarifier and prompts, with a model scripted by what each
 * call's system prompt asks for. A guesthouse's room booking is the invented example.
 */

const ROUTINE_ID = "routine:guesthouse:room-booking:v1";
const at = new Date("2026-11-01T00:00:00.000Z");
const MARCH_DATES = { arrival: "2027-03-08", departure: "2027-03-10" };

const roomBooking: RoutineDefinition = {
  id: ROUTINE_ID,
  agentId: "agent-guesthouse",
  lineageId: "lineage:room-booking",
  version: 1,
  enabled: true,
  createdAt: at,
  updatedAt: at,
  name: "Room booking",
  activation: {
    triggerDescription: "the visitor wants to book a room for their stay",
    gateRef: null,
    priority: 0,
    reentryMode: "once_per_conversation",
    startMode: "offer",
  },
  slots: [
    { stableSlotId: "slot_arrival", key: "arrival", type: "date", required: true, description: "Arrival date.", ordinal: 0 },
    { stableSlotId: "slot_departure", key: "departure", type: "date", required: true, description: "Departure date.", ordinal: 1 },
    { stableSlotId: "slot_room", key: "room", type: "text", required: true, description: "Room type.", ordinal: 2 },
  ],
  steps: [
    { stableStepId: "ask_dates", kind: "chat", instruction: "Ask for the arrival and departure dates: {{slot.arrival}} {{slot.departure}}", toolRef: null, actionType: null, ordinal: 0, metadata: {} },
    { stableStepId: "ask_room", kind: "chat", instruction: "Ask which room they would like: {{slot.room}}", toolRef: null, actionType: null, ordinal: 1, metadata: {} },
  ],
  transitions: [
    { fromStep: "ask_dates", toRef: "ask_room", guardKind: "default", guardText: null, outcomeStatus: null, counterLimit: null, fieldRef: null, fieldOp: null, fieldValue: null, fieldValues: null, fieldUnit: null, ordinal: 0 },
    { fromStep: "ask_room", toRef: "done", guardKind: "default", guardText: null, outcomeStatus: null, counterLimit: null, fieldRef: null, fieldOp: null, fieldValue: null, fieldValues: null, fieldUnit: null, ordinal: 1 },
  ],
  terminals: [{ stableStepId: "done", kind: "complete", instruction: "Confirm the request was passed on.", ordinal: 0 }],
};

/** How the ranker reads each visitor message: whether it asks for the booking or explores it. */
interface Ranking {
  confidence: number;
  directRequest: boolean;
  variables?: Record<string, string>;
}

/** What the offer's reply map makes of each reply. */
type OfferReply = { kind: "chosen"; id: string } | { kind: "declined" } | { kind: "unrelated" };

const EXPLORING = "I'd like to come 8-10 March, is there a single room and what does it cost?";
const BOOKING = "I want to book a room for 8-10 March";
const DIRECT_ANSWER = "Single rooms are free from 8 to 10 March at 80 euro a night. Would you like me to book one?";
const ASK_ROOM_REPLY = "Which room would you like?";


/**
 * Answers each model call by what its system prompt asks for. Records the system prompts so a
 * test can read what the answer was told to close with.
 */
const scriptedModel = (script: { rankings: Record<string, Ranking | null>; offerReplies: Record<string, OfferReply> }) => {
  const prompts: Array<{ kind: string; systemPrompt: string }> = [];
  const answerFor = (systemPrompt: string, userText: string): string => {
    if (systemPrompt.includes("Rank whether the latest user message wants to start any registered routine")) {
      prompts.push({ kind: "activation", systemPrompt });
      const ranking = script.rankings[userText];
      return JSON.stringify({ matches: ranking ? [{ routineId: ROUTINE_ID, ...ranking }] : [] });
    }
    if (systemPrompt.includes("an answer that ended by offering to start something")) {
      prompts.push({ kind: "offer-reply", systemPrompt });
      return JSON.stringify(script.offerReplies[userText] ?? { kind: "unrelated" });
    }
    if (systemPrompt.includes("You are guiding a user through a structured, multi-step routine")) {
      prompts.push({ kind: "selector", systemPrompt });
      return JSON.stringify({ claimsAuthority: false, condition: null, offTopic: false, variables: {} });
    }
    if (systemPrompt.includes("Ask which room they would like")) {
      prompts.push({ kind: "step-reply", systemPrompt });
      return ASK_ROOM_REPLY;
    }
    prompts.push({ kind: "answer", systemPrompt });
    return DIRECT_ANSWER;
  };
  const chatGateway: ChatGateway = {
    async answer(input: ChatGatewayInput) {
      return answerFor(`${input.systemPrompt ?? ""}\n${input.prompt}`, input.query);
    },
    async *streamAnswer(input: ChatGatewayInput) {
      yield answerFor(`${input.systemPrompt ?? ""}\n${input.prompt}`, input.query);
    },
  };
  const clarifierGateway: ConversationModelGateway = {
    complete: vi.fn(async (request) => ({
      text: answerFor(request.systemPrompt ?? "", request.messages.at(-1)?.content ?? ""),
    })),
  };
  return { chatGateway, clarifierGateway, prompts };
};

/** The pending row and the offer memory, as Postgres keeps them across turns. */
const clarificationStore = () => {
  let pending: PendingClarification | null = null;
  const offered = new Set<string>();
  const offerStore: RoutineOfferStore = {
    async loadOffered() {
      return [...offered];
    },
    async record({ routineId }) {
      offered.add(routineId);
    },
  };
  const store: ChatClarificationStore & {
    pending: () => PendingClarification | null;
    offered: () => string[];
    offerStore: RoutineOfferStore;
  } = {
    async loadPending() {
      return pending?.status === "pending" ? pending : null;
    },
    async save(row) {
      pending = row;
    },
    async clear({ outcome }) {
      pending = pending ? { ...pending, status: outcome ?? "resolved" } : null;
    },
    pending: () => (pending?.status === "pending" ? pending : null),
    offered: () => [...offered],
    offerStore,
  };
  return store;
};

const fallbackReplyComposer: FallbackReplyComposer = {
  async composeNoContext() {
    return { text: "I couldn't find that.", declineReason: "content_gap" };
  },
};

/** Every turn answers directly: the routine attempt runs first, then the composer if nothing claimed it. */
const directAnswerPipeline = {
  async interpret(input: { workspaceId: string; query: string }) {
    const request = { workspaceId: input.workspaceId, query: input.query, history: [] };
    return {
      request,
      traceStartedAtMs: Date.now(),
      context: {
        startedAt: Date.now(),
        durationMs: 1,
        result: {
          request,
          settings: {
            workspaceId: input.workspaceId, queryRewriteEnabled: false, semanticRewriteInstructions: "",
            lexicalRewriteInstructions: "", suggestedQuestionsEnabled: false, suggestedQuestionsCount: 0,
            rerankEnabled: false, vectorTopK: 20, similarityThreshold: 0.1, rerankTopK: 5,
            citationDisplayEnabled: true, metadataRules: [], createdAt: new Date(), updatedAt: new Date(),
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
        citationDisplayEnabled: true, suggestedQuestionsEnabled: false, suggestedQuestionsCount: 0,
        customInstruction: "", responseLanguagePolicy: "match_user_question",
      },
      diagnostics: { retrievalSkipped: true },
      trace: { startedAt: new Date().toISOString(), stages: [], links: [] },
    };
  },
};

const revision: AgentRevision = {
  id: "55555555-5555-4555-8555-555555555555",
  snapshot: { customInstruction: "", directives: [], routines: [], contextVariableEnablements: [] },
  sourceDraftGeneration: 1,
  sourceBasePublishedRevisionId: null,
  createdAt: new Date(0),
  publishedAt: null,
  publishedVersion: null,
};

const registration: RoutineRegistration = {
  routine: compileRoutineDefinition(roomBooking),
  trigger: { description: roomBooking.activation.triggerDescription, priority: 0 },
};

const routineProvider = (): ChatRoutineProvider => createRoutineTurnProvider({
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
  }, { revisionReader: { findRevision: vi.fn(async () => revision) } }),
  routineDefinitionRepository: {
    searchActivationTriggerEmbeddings: vi.fn(async () => ({ matches: [], noVectorRoutineIds: [ROUTINE_ID] })),
  },
  routineInvocableSkillNames: { listByKindForAgent: vi.fn(async () => ({ webhook: [], customer_email: [], slack: [] })) } as never,
  routineRegistrations: [registration],
  routineTriggerEmbeddingService: { persistPublished: vi.fn() },
  skillExecutorRegistry: {} as never,
  approvalResumeEffectJournal: {} as never,
  turnPlanAdapters: {
    activator: ({ fallback }) => fallback,
    reentryGate: ({ fallback }) => fallback,
    slotCorrection: ({ fallback }) => fallback,
  },
});

const guesthouse = async (script: Parameters<typeof scriptedModel>[0]) => {
  const model = scriptedModel(script);
  const agent = await new InMemoryAgentRepository().create("workspace-1", { name: "Guesthouse" });
  const conversationRepository = new InMemoryConversationRepository();
  const conversation = await conversationRepository.create({ workspaceId: "workspace-1", agentId: agent.id });
  pinExistingConversationsToPublishedRevisions(conversationRepository);
  const saved: RoutineState[] = [];
  let active: RoutineState | null = null;
  const routineStore = {
    loadActive: vi.fn(async () => active),
    save: vi.fn(async (state: RoutineState) => {
      saved.push(state);
      active = state.status === "active" ? state : null;
    }),
    clear: vi.fn(async () => {
      active = null;
    }),
  };
  const clarifications = clarificationStore();
  const metrics = new MetricsRegistry();
  const service = new ChatService({
    conversationRepository,
    messageRepository: new InMemoryMessageRepository(),
    retrievalTurn: new RetrievalTurnController(directAnswerPipeline as never),
    chatGateway: model.chatGateway,
    auditService: createAuditService(),
    turnRuntime: buildChatTurnRuntime({
      chatGateway: model.chatGateway,
      fallbackReplyComposer,
      skillOutcomeCapabilities: { supportsGroundedAnswer: () => false },
      metrics,
    }),
    agentService: { resolve: vi.fn(async () => agent) },
    agentRevisionRuntimeResolver: publishedRevisionResolverFixture(),
    turnRouter: { classify: async () => ({ route: "direct" as const, framing: { isIdentityQuestion: false } }) },
    conversationEngine: createConversationEngine(),
    routineStore,
    routineProvider: routineProvider(),
    clarifier: new DefaultClarifier(model.clarifierGateway, {
      questionPromptTemplate: loadPromptTemplate("chat/clarification-question.md"),
      replyMapPromptTemplate: loadPromptTemplate("chat/clarification-reply-map.md"),
      offerReplyMapPromptTemplate: loadPromptTemplate("chat/clarification-offer-reply-map.md"),
      routineOfferReplyMapPromptTemplate: loadPromptTemplate("chat/clarification-routine-offer-reply-map.md"),
    }),
    clarificationStore: clarifications,
    routineOfferStore: clarifications.offerStore,
    recordClarificationDecision: (decision) => {
      metrics.incrementCounter("clarification_decisions_total", { help: "test", labels: { ...decision } });
    },
  });
  const say = async (query: string) => service.answer({
    workspaceId: "workspace-1",
    conversationId: conversation.id,
    query,
    stream: false,
  });
  return { say, saved, clarifications, prompts: model.prompts, metrics };
};

const answerPrompts = (prompts: Array<{ kind: string; systemPrompt: string }>) =>
  prompts.filter((prompt) => prompt.kind === "answer").map((prompt) => prompt.systemPrompt);

const OFFER_CLOSING = "Closing sentence: an offer to start";

describe("an Offer-first routine in a conversation", () => {
  it("answers an exploring question and offers the booking, then starts it holding the dates when accepted", async () => {
    const turn = await guesthouse({
      rankings: { [EXPLORING]: { confidence: 0.94, directRequest: false, variables: MARCH_DATES } },
      offerReplies: { "yes please": { kind: "chosen", id: ROUTINE_ID } },
    });

    const offered = await turn.say(EXPLORING);

    expect(offered.answer).toBe(DIRECT_ANSWER);
    expect(turn.saved).toEqual([]);
    expect(answerPrompts(turn.prompts).at(-1)).toContain(OFFER_CLOSING);
    expect(answerPrompts(turn.prompts).at(-1)).toContain("Room booking");
    expect(turn.clarifications.pending()).toMatchObject({
      source: "routine_activation",
      mode: "offer",
      candidates: [{ id: ROUTINE_ID, payload: { routineId: ROUTINE_ID, variables: MARCH_DATES } }],
    });
    expect(turn.clarifications.offered()).toEqual([ROUTINE_ID]);
    expect(turn.metrics.renderPrometheus()).toMatch(/decision="offered",reason="offer_first",surface="routine_activation"/);

    const accepted = await turn.say("yes please");

    expect(accepted.answer).toBe(ASK_ROOM_REPLY);
    expect(turn.saved.at(-1)).toMatchObject({ routineId: ROUTINE_ID, variables: MARCH_DATES, status: "active" });
    expect(turn.clarifications.pending()).toBeNull();
    expect(turn.metrics.renderPrometheus()).toMatch(/decision="offer_accepted",surface="routine_activation"/);
  });

  it("starts nothing when the offer is declined, offers it no more, and still starts on a clear request", async () => {
    const turn = await guesthouse({
      rankings: {
        [EXPLORING]: { confidence: 0.94, directRequest: false, variables: MARCH_DATES },
        "no thanks": null,
        "Do your rooms have a view of the lake?": { confidence: 0.7, directRequest: false },
        [BOOKING]: { confidence: 0.97, directRequest: true, variables: MARCH_DATES },
      },
      offerReplies: { "no thanks": { kind: "declined" } },
    });

    await turn.say(EXPLORING);
    const declined = await turn.say("no thanks");

    expect(declined.answer).toBe(DIRECT_ANSWER);
    expect(turn.saved).toEqual([]);
    expect(answerPrompts(turn.prompts).at(-1)).not.toContain(OFFER_CLOSING);
    expect(turn.metrics.renderPrometheus()).toMatch(/decision="offer_declined",surface="routine_activation"/);

    await turn.say("Do your rooms have a view of the lake?");

    expect(turn.saved).toEqual([]);
    expect(answerPrompts(turn.prompts).at(-1)).not.toContain(OFFER_CLOSING);
    expect(turn.clarifications.pending()).toBeNull();

    const booked = await turn.say(BOOKING);

    expect(booked.answer).toBe(ASK_ROOM_REPLY);
    expect(turn.saved.at(-1)).toMatchObject({ routineId: ROUTINE_ID, variables: MARCH_DATES });
  });

  it("treats an offer the visitor moves past as ignored", async () => {
    const turn = await guesthouse({
      rankings: { [EXPLORING]: { confidence: 0.94, directRequest: false, variables: MARCH_DATES } },
      offerReplies: {},
    });

    await turn.say(EXPLORING);
    await turn.say("Is breakfast included?");

    expect(turn.saved).toEqual([]);
    expect(turn.metrics.renderPrometheus()).toMatch(/decision="offer_ignored",surface="routine_activation"/);
  });

  it("starts at once on a clear request, with no offer", async () => {
    const turn = await guesthouse({
      rankings: { [BOOKING]: { confidence: 0.97, directRequest: true, variables: MARCH_DATES } },
      offerReplies: {},
    });

    const booked = await turn.say(BOOKING);

    expect(booked.answer).toBe(ASK_ROOM_REPLY);
    expect(turn.saved.at(-1)).toMatchObject({ routineId: ROUTINE_ID, variables: MARCH_DATES });
    expect(turn.clarifications.pending()).toBeNull();
    expect(turn.clarifications.offered()).toEqual([]);
  });
});
