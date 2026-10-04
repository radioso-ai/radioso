import { vi } from "vitest";

import { createConversationEngine } from "@radioso/conversation-engine";

import type { AuditService } from "../../src/modules/audit/contracts/index.js";
import type { ConversationRepositoryPort } from "../../src/db/repositories/conversationRepository.js";
import type { MessageRepositoryPort } from "../../src/db/repositories/messageRepository.js";
import type { ConversationOwnershipRecord } from "../../src/modules/handoff/public.js";
import type { ChatAnswerCoverageAssessment } from "../../src/modules/chat/contracts/answerCoverage.js";
import type { ChatReviewResult } from "../../src/modules/chat/types/chatReview.js";
import type { ChatPresentedAnswer } from "../../src/modules/chat/services/chatAnswerPresenter.js";
import type { PreparedSession } from "../../src/modules/chat/services/chatSessionPreparer.js";
import { ChatService, type ChatServiceOptions } from "../../src/modules/chat/services/chatService.js";
import {
  ChatTurnLifecycle,
  type AssistantTurnPersistencePort,
  type OwnershipHandoffInput,
} from "../../src/modules/chat/services/chatTurnLifecycle.js";
import { buildChatTurnRuntime } from "../../src/modules/chat/services/chatTurnRuntime.js";
import { MissingFallbackReplyComposer } from "../../src/modules/chat/services/fallbackReplyComposer.js";
import { RetrievalTurnController } from "../../src/modules/chat/services/retrievalTurnDispatch.js";
import { chatReviewResult } from "../../src/modules/chat/services/reviewDraft.js";
import { resolveContextForTurn } from "../../src/modules/context-variables/public.js";
import type { SuppressedSkillEffect } from "../../src/shared/domain/suppressedSkillEffect.js";
import {
  createAuditService,
  InMemoryAuditEventRepository,
  InMemoryConversationRepository,
  InMemoryMessageRepository,
  pinExistingConversationsToPublishedRevisions,
  publishedRevisionResolverFixture,
} from "./fakes.js";

export const REVIEW_WORKSPACE_ID = "workspace-review";
export const REVIEW_AGENT_ID = "agent-review";

/** A human-owned ownership row at `version`, as the ownership reader returns it. */
export const humanOwnedRecord = (conversationId: string, version: number): ConversationOwnershipRecord => ({
  conversationId,
  workspaceId: REVIEW_WORKSPACE_ID,
  state: "human_owned",
  ownerAccountId: null,
  ownerUserId: null,
  ownerProfile: null,
  ownerStoredLabel: null,
  reason: "operator_takeover",
  version,
  takenOverAt: new Date("2026-10-01T09:00:00.000Z"),
  createdAt: new Date("2026-10-01T09:00:00.000Z"),
  updatedAt: new Date("2026-10-01T09:00:00.000Z"),
});

export const aiOwnedRecord = (conversationId: string, version: number): ConversationOwnershipRecord => ({
  ...humanOwnedRecord(conversationId, version),
  state: "ai_owned",
  reason: null,
  takenOverAt: null,
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

export interface ReviewServiceHarnessOptions {
  /** The reply the model writes. */
  answer?: string;
  ownership?: ConversationOwnershipRecord | null;
  /** Wires the transactional persistence port, as production does, or leaves the fallback path. */
  persistence?: "port" | "fallback";
  /** Earlier messages recorded before the answered one (alternating customer and agent). */
  earlierMessages?: number;
  agentSkillTurnSkillProvider?: ChatServiceOptions["agentSkillTurnSkillProvider"];
}

/**
 * A ChatService over in-memory stores with an email conversation whose newest message is
 * the recorded customer message a review turn answers.
 */
export const reviewServiceHarness = async (options: ReviewServiceHarnessOptions = {}) => {
  const conversationRepository = new InMemoryConversationRepository();
  const messageRepository = new InMemoryMessageRepository();
  const conversation = await conversationRepository.create({ workspaceId: REVIEW_WORKSPACE_ID, sourceChannel: "email" });
  pinExistingConversationsToPublishedRevisions(conversationRepository);
  const earlier = [];
  for (let index = 0; index < (options.earlierMessages ?? 4); index += 1) {
    earlier.push(await messageRepository.create({
      conversationId: conversation.id,
      workspaceId: REVIEW_WORKSPACE_ID,
      role: index % 2 === 0 ? "user" : "assistant",
      content: `Earlier message ${index + 1}`,
    }));
  }
  const requestMessage = await messageRepository.create({
    conversationId: conversation.id,
    workspaceId: REVIEW_WORKSPACE_ID,
    role: "user",
    content: "Can I change my delivery address?",
  });
  const auditRepository = new InMemoryAuditEventRepository();
  const gatewayHistories: number[] = [];
  const chatGateway: ChatServiceOptions["chatGateway"] = {
    answer: vi.fn(async (input) => {
      gatewayHistories.push(input.history.length);
      return options.answer ?? "Yes, reply with the new address and we will update it.";
    }),
    async *streamAnswer() {
      yield options.answer ?? "unused";
    },
  };
  const reservation = { commit: vi.fn(async () => {}), release: vi.fn(async () => {}) };
  const usageLimitPolicy: NonNullable<ChatServiceOptions["usageLimitPolicy"]> = {
    reserveAnswer: vi.fn(async () => reservation),
    reserveDocument: vi.fn(async () => reservation),
    reserveIndexedStorage: vi.fn(async () => reservation),
    reserveMonthlyIndexedContent: vi.fn(async () => reservation),
  };
  const conversationOwnershipReader: NonNullable<ChatServiceOptions["conversationOwnershipReader"]> = {
    load: vi.fn(async () => (options.ownership === undefined
      ? aiOwnedRecord(conversation.id, 3)
      : options.ownership)),
  };
  const handoffWaitingMessageGenerator: NonNullable<ChatServiceOptions["handoffWaitingMessageGenerator"]> = {
    generate: vi.fn(async () => "A teammate will join shortly."),
  };
  const routineStore: NonNullable<ChatServiceOptions["routineStore"]> = {
    loadActive: vi.fn(async () => null),
    save: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
  };
  const routineProvider: NonNullable<ChatServiceOptions["routineProvider"]> = {
    forTurn: vi.fn(async () => null),
  };
  const suspendedRoutineReader: NonNullable<ChatServiceOptions["suspendedRoutineReader"]> = {
    loadSuspended: vi.fn(async () => ({
      sessionId: conversation.id,
      routineId: "contact.request",
      path: ["await_approval"],
      variables: {},
      status: "suspended" as const,
    })),
  };
  const assistantTurnPersistence: AssistantTurnPersistencePort = {
    completeAssistantTurn: vi.fn(async () => {
      throw new Error("a review turn never persists a reply");
    }),
  };
  const actionOutbox: NonNullable<ChatServiceOptions["actionOutbox"]> = {
    enqueue: vi.fn(async () => ({ id: "action-1", duplicate: false })),
  };
  const service = new ChatService({
    conversationRepository,
    messageRepository,
    retrievalTurn: directOnlyRetrievalTurn(),
    chatGateway,
    auditService: createAuditService(auditRepository),
    turnRuntime: buildChatTurnRuntime({
      chatGateway,
      fallbackReplyComposer: new MissingFallbackReplyComposer(),
      skillOutcomeCapabilities: { supportsGroundedAnswer: () => false },
    }),
    agentRevisionRuntimeResolver: publishedRevisionResolverFixture(),
    turnRouter: { classify: async () => ({ route: "direct", framing: { isIdentityQuestion: false } }) },
    conversationEngine: createConversationEngine(),
    usageLimitPolicy,
    conversationOwnershipReader,
    handoffWaitingMessageGenerator,
    routineStore,
    routineProvider,
    suspendedRoutineReader,
    actionOutbox,
    ...(options.persistence === "port" ? { assistantTurnPersistence } : {}),
    ...(options.agentSkillTurnSkillProvider ? { agentSkillTurnSkillProvider: options.agentSkillTurnSkillProvider } : {}),
  });
  const review = (overrides: { maxMessages?: number; existingUserMessageId?: string } = {}) => service.review({
    workspaceId: REVIEW_WORKSPACE_ID,
    agentId: REVIEW_AGENT_ID,
    conversationId: conversation.id,
    existingUserMessageId: overrides.existingUserMessageId ?? requestMessage.id,
    historyWindow: { maxMessages: overrides.maxMessages ?? 2 },
  });
  return {
    service,
    review,
    conversation,
    earlier,
    requestMessage,
    messageRepository,
    auditRepository,
    chatGateway,
    gatewayHistories,
    usageLimitPolicy,
    reservation,
    conversationOwnershipReader,
    handoffWaitingMessageGenerator,
    routineStore,
    routineProvider,
    suspendedRoutineReader,
    assistantTurnPersistence,
    actionOutbox,
  };
};

const lifecycleSession = (answerCoverage?: ChatAnswerCoverageAssessment): PreparedSession =>
  ({
    agent: { id: REVIEW_AGENT_ID, name: "Support", chatModelOverride: null },
    conversation: { id: "conversation-review", sourceChannel: "email" },
    history: [],
    userMessage: { id: "request-message", content: "Where is my order?" },
    turnRoute: "retrieval",
    directiveSteering: { rules: [], matches: [], omissions: [] },
    stagedContext: [],
    resolvedContext: resolveContextForTurn(null),
    retrieval: {
      contexts: [],
      diagnostics: {},
      systemPrompt: undefined,
      trace: { traceId: "trace-review", startedAt: "2026-10-01T09:00:00.000Z", stages: [], links: [] },
    },
    ...(answerCoverage ? { answerCoverageDebug: answerCoverage } : {}),
  } as unknown as PreparedSession);

/** Lifecycle collaborators that fail a test if a review turn writes a reply. */
export const reviewLifecycleHarness = () => {
  const audit = {
    record: vi.fn(async () => {}),
    logRecorded: vi.fn(),
    updateChatAnswerSuggestions: vi.fn(async () => {}),
  };
  const messageRepository = { create: vi.fn(async () => ({ id: "assistant-message" })) };
  const conversationRepository = { touch: vi.fn(async () => {}) };
  const persistence: AssistantTurnPersistencePort = {
    completeAssistantTurn: vi.fn(async () => {
      throw new Error("a review turn never persists a reply");
    }),
  };
  const ownershipRepository = { requestHandoff: vi.fn(async () => ({ changed: true }) as never) };
  const actionOutbox = { enqueue: vi.fn(async () => ({ id: "action-1", duplicate: false })) };
  const pendingDecisionRepository = { create: vi.fn(async () => ({})) };
  const lifecycle = (path: "port" | "fallback") => new ChatTurnLifecycle(
    conversationRepository as unknown as ConversationRepositoryPort,
    messageRepository as unknown as MessageRepositoryPort,
    audit as unknown as AuditService,
    undefined,
    actionOutbox,
    path === "port" ? persistence : undefined,
    undefined,
    undefined,
    undefined,
    pendingDecisionRepository,
    ownershipRepository,
  );
  return { lifecycle, audit, messageRepository, conversationRepository, persistence, ownershipRepository, actionOutbox, pendingDecisionRepository };
};

export interface ReviewedTurnFixtureInput {
  presentation?: Partial<ChatPresentedAnswer>;
  answerCoverage?: ChatAnswerCoverageAssessment;
  ownershipHandoff?: OwnershipHandoffInput;
  suppressedEffects?: readonly SuppressedSkillEffect[];
  ownershipVersion?: number;
}

/**
 * A `ChatReviewResult` produced by the real lifecycle: the turn completes in `review`
 * mode and the review draft builder maps the completion, exactly as `ChatService.review` does.
 */
export const reviewedTurnFixture = async (input: ReviewedTurnFixtureInput = {}): Promise<ChatReviewResult> => {
  const { lifecycle } = reviewLifecycleHarness();
  const session = lifecycleSession(input.answerCoverage);
  const completed = await lifecycle("fallback").completeAssistantTurn({
    workspaceId: REVIEW_WORKSPACE_ID,
    session,
    presentation: {
      answer: "Your order ships tomorrow.",
      skillName: "retrieval.answer",
      skillOutcome: "grounded",
      skillStatus: "completed",
      answerOutcome: "grounded_success",
      citations: [],
      ...input.presentation,
    },
    answerStartedAt: Date.now(),
    stream: false,
    executionMode: "review",
    ownershipHandoff: input.ownershipHandoff,
    suppressedEffects: input.suppressedEffects,
  });
  if (completed.kind !== "draft") {
    throw new Error("a review turn completes as a draft");
  }
  return chatReviewResult({
    conversationId: session.conversation.id,
    ownershipVersion: input.ownershipVersion ?? 1,
    draft: completed.draft,
    facts: completed.facts,
  });
};
