import { describe, expect, expectTypeOf, it, vi } from "vitest";

import type { RoutineState } from "@radioso/conversation-contract";
import { createConversationEngine } from "@radioso/conversation-engine";

import { ChatService, type ChatServiceOptions } from "../../../src/modules/chat/services/chatService.js";
import type { ChatTurnLifecycle } from "../../../src/modules/chat/services/chatTurnLifecycle.js";
import { buildChatTurnRuntime } from "../../../src/modules/chat/services/chatTurnRuntime.js";
import { MissingFallbackReplyComposer } from "../../../src/modules/chat/services/fallbackReplyComposer.js";
import { RetrievalTurnController } from "../../../src/modules/chat/services/retrievalTurnDispatch.js";
import {
  turnExecutionCapabilities,
  type TurnExecutionCapabilities,
  type TurnExecutionMode,
} from "../../../src/shared/domain/turnExecutionMode.js";
import {
  createAuditService,
  InMemoryConversationRepository,
  InMemoryMessageRepository,
  pinExistingConversationsToPublishedRevisions,
  publishedRevisionResolverFixture,
} from "../../support/fakes.js";

// Keyed by every mode, so adding a mode fails to compile until its row is pinned here.
const EXPECTED_CAPABILITIES: Record<TurnExecutionMode, TurnExecutionCapabilities> = {
  live: {
    routines: "activate",
    completion: "persist_reply",
    ownershipHandoff: "apply",
    turnActions: "enqueue",
    humanOwnedWaitingMessage: "generate",
    turnBookkeeping: "record",
  },
  safe_test: {
    routines: "activate",
    completion: "persist_reply",
    ownershipHandoff: "skip",
    turnActions: "drop",
    humanOwnedWaitingMessage: "generate",
    turnBookkeeping: "skip",
  },
};

const MODES = Object.keys(EXPECTED_CAPABILITIES) as TurnExecutionMode[];

describe("turnExecutionCapabilities", () => {
  it.each(MODES)("pins every %s capability", (mode) => {
    expect(turnExecutionCapabilities(mode)).toStrictEqual(EXPECTED_CAPABILITIES[mode]);
  });

  it("treats an unset mode as live", () => {
    expect(turnExecutionCapabilities(undefined)).toStrictEqual(EXPECTED_CAPABILITIES.live);
  });
});

describe("CompletedAssistantTurn", () => {
  type CompletedAssistantTurn = Awaited<ReturnType<ChatTurnLifecycle["completeAssistantTurn"]>>;
  type PersistedAssistantTurn = Extract<CompletedAssistantTurn, { kind: "persisted" }>;

  it("has a persisted arm carrying the reply, its message id and the post-commit receipt", () => {
    expectTypeOf<PersistedAssistantTurn>().not.toBeNever();
    expectTypeOf<PersistedAssistantTurn["assistantMessageId"]>().toEqualTypeOf<string>();
    expectTypeOf<PersistedAssistantTurn>().toHaveProperty("response");
    expectTypeOf<PersistedAssistantTurn>().toHaveProperty("postCommitReceipt");
  });
});

const directOnlyRetrievalTurn = (): ChatServiceOptions["retrievalTurn"] =>
  new RetrievalTurnController({
    async interpret() {
      return { retrievalQuery: "hello", shouldRetrieve: false, reason: "direct" };
    },
    async runInterpreted() {
      throw new Error("retrieval should not run in these turns");
    },
    async runWithoutRetrieval() {
      return {
        rewrittenQuery: "hello",
        contexts: [],
        prompt: "",
        citations: [],
        responseIdentity: null,
        responseSettings: {
          citationDisplayEnabled: true,
          suggestedQuestionsEnabled: true,
          suggestedQuestionsCount: 3,
          customInstruction: "",
          responseLanguagePolicy: "match_user_question",
        },
        diagnostics: { rewriteStatus: "skipped", retrievalSkipped: true },
        trace: { traceId: "trace_direct", startedAt: "2026-01-01T00:00:00.000Z", stages: [], links: [] },
      };
    },
  } as never);

const contactRoutineProvider = (sessionId: string): NonNullable<ChatServiceOptions["routineProvider"]> => ({
  forTurn: vi.fn(async () => ({
    activator: { activate: async () => ({ kind: "activate" as const, routineId: "contact.request" }) },
    runner: {
      resume: async () => ({
        response: { answer: "What is your email?" },
        nextState: {
          sessionId,
          routineId: "contact.request",
          path: ["ask_email"],
          variables: {},
          status: "active" as const,
        },
      }),
    },
  })),
});

const routineTurnHarness = async (suspended: boolean) => {
  const conversationRepository = new InMemoryConversationRepository();
  const conversation = await conversationRepository.create({ workspaceId: "workspace-1" });
  pinExistingConversationsToPublishedRevisions(conversationRepository);
  const chatGateway: ChatServiceOptions["chatGateway"] = {
    async answer() {
      return "Normal answer.";
    },
    async *streamAnswer() {
      yield "Normal answer.";
    },
  };
  const routineProvider = contactRoutineProvider(conversation.id);
  const suspendedState: RoutineState = {
    sessionId: conversation.id,
    routineId: "contact.request",
    path: ["await_approval"],
    variables: {},
    status: "suspended",
  };
  const suspendedRoutineReader: NonNullable<ChatServiceOptions["suspendedRoutineReader"]> = {
    loadSuspended: vi.fn(async () => (suspended ? suspendedState : null)),
  };
  const service = new ChatService({
    conversationRepository,
    messageRepository: new InMemoryMessageRepository(),
    retrievalTurn: directOnlyRetrievalTurn(),
    chatGateway,
    auditService: createAuditService(),
    turnRuntime: buildChatTurnRuntime({
      chatGateway,
      fallbackReplyComposer: new MissingFallbackReplyComposer(),
      skillOutcomeCapabilities: { supportsGroundedAnswer: () => false },
    }),
    agentRevisionRuntimeResolver: publishedRevisionResolverFixture(),
    turnRouter: { classify: async () => ({ route: "direct", framing: { isIdentityQuestion: false } }) },
    conversationEngine: createConversationEngine(),
    routineStore: {
      loadActive: vi.fn(async () => null),
      save: vi.fn(async () => {}),
      clear: vi.fn(async () => {}),
    },
    routineProvider,
    suspendedRoutineReader,
  });
  return { service, conversationId: conversation.id, routineProvider, suspendedRoutineReader };
};

describe("routine capabilities in ChatService.answer", () => {
  it.each(MODES)("attempts routine activation in %s mode when no routine is suspended", async (executionMode) => {
    const { service, conversationId, routineProvider, suspendedRoutineReader } = await routineTurnHarness(false);

    const response = await service.answer({
      workspaceId: "workspace-1",
      conversationId,
      query: "I would like someone to contact me.",
      stream: false,
      executionMode,
    });

    expect(response.answer).toContain("What is your email?");
    expect(suspendedRoutineReader.loadSuspended).toHaveBeenCalledWith({ sessionId: conversationId });
    expect(routineProvider.forTurn).toHaveBeenCalledOnce();
  });

  it.each(MODES)("short-circuits a suspended routine in %s mode without attempting activation", async (executionMode) => {
    const { service, conversationId, routineProvider, suspendedRoutineReader } = await routineTurnHarness(true);

    const response = await service.answer({
      workspaceId: "workspace-1",
      conversationId,
      query: "hello",
      stream: false,
      executionMode,
    });

    expect(response.answer).toBe("Normal answer.");
    expect(suspendedRoutineReader.loadSuspended).toHaveBeenCalledWith({ sessionId: conversationId });
    expect(routineProvider.forTurn).not.toHaveBeenCalled();
  });
});
