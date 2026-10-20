import { vi } from "vitest";

import { createConversationEngine } from "@radioso/conversation-engine";

import type {
  AnswerCoverageReactionRepositoryPort,
  AnswerCoverageRecord,
  AnswerCoverageRepositoryPort,
} from "../../src/modules/answerCoverage/public.js";
import type { ChatResponse, ChatReviewResult } from "../../src/modules/chat/contracts/index.js";
import { AnswerCoverageHeadRecorder } from "../../src/modules/chat/services/answerCoverageHeadRecorder.js";
import { ChatService, type ChatServiceOptions } from "../../src/modules/chat/services/chatService.js";
import { buildChatTurnRuntime } from "../../src/modules/chat/services/chatTurnRuntime.js";
import { createRouteScopedDirectiveSteering } from "../../src/modules/chat/services/routeScopedDirectiveSteering.js";
import { MissingFallbackReplyComposer } from "../../src/modules/chat/services/fallbackReplyComposer.js";
import type { RetrievalTurnPort } from "../../src/modules/chat/services/retrievalTurnDispatch.js";
import { publishedDraftReply } from "../../src/modules/chat/services/reviewDraft.js";
import type { EvalRunObservedOutput } from "../../src/modules/eval/domain/types.js";
import {
  conversationQualityCaseTurnText,
  type ConversationQualityCase,
  type ConversationQualityObservedOutput,
  type ConversationQualityRunnerPort,
} from "../../src/modules/eval/suite/index.js";
import type { Directive } from "../../src/modules/directives/public.js";
import type { RetrievalPipelineRequest, RetrievalPipelineResult } from "../../src/modules/retrieval/public.js";
import { DefaultAllowCapabilityPolicy } from "../../src/shared/domain/capabilityPolicy.js";
import { MetricsRegistry } from "../../src/shared/observability/metrics/metricsRegistry.js";
import { CQ_AGENT_ID, CQ_WORKSPACE_ID } from "../fixtures/conversation-quality/index.js";
import { conversationQualityCorpus, REFUND_POLICY_DOC_ID } from "../fixtures/conversation-quality/corpus.js";
import {
  createAuditService,
  InMemoryConversationRepository,
  InMemoryMessageRepository,
  publishedRevisionIdFor,
  publishedRevisionResolverFixture,
} from "./fakes.js";

/** Retrieval that always finds one seed document, so every turn is a grounded retrieval turn. */
const singleDocumentRetrieval = (documentId: string): RetrievalTurnPort => {
  const document = conversationQualityCorpus.find((candidate) => candidate.id === documentId);
  if (!document) {
    throw new Error(`No conversation-quality document ${documentId}`);
  }
  return {
    async interpret(request) {
      return {
        request,
        traceStartedAtMs: Date.now(),
        context: { result: {} as never, startedAt: Date.now(), durationMs: 0 },
        interpretation: { startedAt: Date.now(), durationMs: 0 },
      };
    },
    async dispatch(input) {
      const request: RetrievalPipelineRequest = input.interpreted.request;
      return {
        rewrittenQuery: request.query,
        contexts: [{
          chunkId: `chunk-${document.id}`,
          documentId: document.id,
          title: document.title,
          content: document.content,
          promptPosition: 0,
          similarity: 0.8,
          fusedScore: 0.8,
          semanticScore: 0.8,
          lexicalScore: 0.8,
          lexicalRankScore: 0.3,
          metadata: {},
        }],
        systemPrompt: "system",
        prompt: "prompt",
        citations: [],
        responseIdentity: request.responseIdentity ?? null,
        responseSettings: {
          citationDisplayEnabled: true,
          suggestedQuestionsEnabled: false,
          suggestedQuestionsCount: 0,
          responseLanguagePolicy: "match_user_question",
        },
        diagnostics: {
          execution: { surface: "assistant", path: "assistant_retrieval", retrievalInvoked: true },
          rewriteStatus: "skipped",
          rerankStatus: "skipped",
          finalContextCount: 1,
          retrievalSkipped: false,
        },
        trace: { traceId: "cq-retrieval", startedAt: new Date().toISOString(), stages: [], links: [] },
      } as unknown as RetrievalPipelineResult;
    },
  };
};

/**
 * Coverage persistence for the head recorder. Wired so the review facts carry the turn's
 * coverage record, as they do in production, where the recorder saves to Postgres.
 */
const inMemoryCoverageRepository = (): AnswerCoverageRepositoryPort & AnswerCoverageReactionRepositoryPort => {
  const records = new Map<string, AnswerCoverageRecord>();
  return {
    async saveAssessment(input) {
      const existing = records.get(input.requestMessageId);
      if (existing) return existing;
      const { assessment, ...correlation } = input;
      const record: AnswerCoverageRecord = {
        ...assessment,
        ...correlation,
        id: `assessment-${records.size + 1}`,
        schemaVersion: assessment.availability === "assessed" ? assessment.schemaVersion : 1,
        assessedAt: new Date(),
        createdAt: new Date(),
      };
      records.set(input.requestMessageId, record);
      return record;
    },
    async findByRequestMessageId(input) {
      return records.get(input.requestMessageId) ?? null;
    },
    async listByRequestMessageIds() {
      return new Map();
    },
    async markInteractionEvaluated() {},
    async recordReaction() {
      throw new Error("the conversation-quality agent configures no coverage reaction");
    },
    async listByAssessmentId() {
      return [];
    },
    async listByAssessmentIds() {
      return new Map();
    },
  };
};

/** A live answer as the suite scores it. */
const observedOutputFromChatResponse = (response: ChatResponse): EvalRunObservedOutput => ({
  retrievedChunks: [],
  answer: response.answer,
  citations: response.citations,
  answerSegments: response.answerSegments,
  suggestions: response.suggestions,
  turnTrace: response.turnTrace,
  activityTrace: response.activityTrace,
});

/**
 * A review turn as the suite scores it. The grounding verdict is read back from the draft's
 * presentation the way publishing reads it, the coverage verdict from the review facts, and
 * the persisted-reply count is what the caller saw the conversation gain while the turn ran.
 */
const observedOutputFromReviewResult = (
  result: ChatReviewResult,
  persistedAssistantMessageCount: number,
): ConversationQualityObservedOutput => {
  if (result.kind === "human_owned") {
    return { retrievedChunks: [], error: { message: "A person owns the conversation, so no review turn ran." } };
  }
  const draft = result.kind === "draft"
    ? publishedDraftReply({ workspaceId: CQ_WORKSPACE_ID, conversationId: result.conversationId, draft: result.draft })
    : null;
  const coverage = result.facts.answerCoverage;
  return {
    retrievedChunks: [],
    ...(draft ? { answer: draft.content } : {}),
    ...(draft?.grounding ? { groundingVerdict: draft.grounding.verdict } : {}),
    reviewTurn: {
      answerCoverage: coverage
        ? { availability: coverage.availability, ...(coverage.coverage ? { coverage: coverage.coverage } : {}) }
        : null,
      persistedAssistantMessageCount,
    },
  };
};

export interface ConversationQualityChatHarnessOptions {
  /** The model's raw reply to the answer call: a canonical answer envelope for a grounded turn. */
  reply: string;
  /** The seed document every turn retrieves; the refund policy when absent. */
  retrievedDocumentId?: string;
  /** Directives registered for every turn, as composition registers the built-ins; none when absent. */
  directives?: Directive[];
}

/**
 * The conversation-quality runner port over a real ChatService on in-memory stores. A live
 * case is a single-turn `ChatService.answer()`; a review case is recorded as an email
 * conversation (its history, then its query as the customer message) and answered by
 * `ChatService.review()`, which returns the reply as a draft. Routine collaborators are
 * spies, so a test can show a review turn never reaches them.
 */
export const conversationQualityChatHarness = (options: ConversationQualityChatHarnessOptions) => {
  const conversationRepository = new InMemoryConversationRepository();
  const messageRepository = new InMemoryMessageRepository();
  const metrics = new MetricsRegistry();
  const chatGateway: ChatServiceOptions["chatGateway"] = {
    answer: vi.fn(async () => options.reply),
    async *streamAnswer() {
      throw new Error("conversation-quality turns run the non-streaming path");
    },
  };
  const routineStore: NonNullable<ChatServiceOptions["routineStore"]> = {
    loadActive: vi.fn(async () => null),
    save: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
  };
  const routineProvider: NonNullable<ChatServiceOptions["routineProvider"]> = {
    forTurn: vi.fn(async () => null),
  };
  const service = new ChatService({
    conversationRepository,
    messageRepository,
    retrievalTurn: singleDocumentRetrieval(options.retrievedDocumentId ?? REFUND_POLICY_DOC_ID),
    ...(options.directives
      ? {
          directiveSteering: createRouteScopedDirectiveSteering({
            capabilityPolicy: new DefaultAllowCapabilityPolicy(),
            registrations: options.directives.map((directive) => ({ directive })),
          }),
        }
      : {}),
    chatGateway,
    auditService: createAuditService(),
    turnRuntime: buildChatTurnRuntime({
      chatGateway,
      fallbackReplyComposer: new MissingFallbackReplyComposer(),
      skillOutcomeCapabilities: { supportsGroundedAnswer: () => true },
      metrics,
    }),
    agentRevisionRuntimeResolver: publishedRevisionResolverFixture(),
    turnRouter: { classify: async () => ({ route: "retrieval", framing: { isIdentityQuestion: false } }) },
    conversationEngine: createConversationEngine(),
    coverageHeadRecorder: new AnswerCoverageHeadRecorder(inMemoryCoverageRepository()),
    routineStore,
    routineProvider,
  });

  const assistantMessageCount = async (conversationId: string): Promise<number> =>
    (await messageRepository.listByConversationId(CQ_WORKSPACE_ID, conversationId))
      .filter((message) => message.role === "assistant").length;

  const recordReviewConversation = async (evalCase: ConversationQualityCase) => {
    // No agent service is wired, so turns resolve the workspace's own agent; the conversation
    // is pinned to that agent's published revision, as a fresh live conversation would be.
    const conversation = await conversationRepository.create({
      workspaceId: CQ_WORKSPACE_ID,
      agentRevisionId: publishedRevisionIdFor(CQ_WORKSPACE_ID),
      sourceChannel: "email",
    });
    const history = evalCase.history ?? [];
    for (const turn of history) {
      await messageRepository.create({ conversationId: conversation.id, workspaceId: CQ_WORKSPACE_ID, ...turn });
    }
    const request = await messageRepository.create({
      conversationId: conversation.id,
      workspaceId: CQ_WORKSPACE_ID,
      role: "user",
      content: conversationQualityCaseTurnText(evalCase),
    });
    return { conversationId: conversation.id, requestMessageId: request.id, historyLength: history.length };
  };

  const port: ConversationQualityRunnerPort = {
    async run(evalCase) {
      if (evalCase.history?.length) {
        throw new Error("This runner drives single-turn live cases only.");
      }
      return observedOutputFromChatResponse(await service.answer({
        workspaceId: CQ_WORKSPACE_ID,
        agentId: CQ_AGENT_ID,
        query: conversationQualityCaseTurnText(evalCase),
        stream: false,
      }));
    },
    async review(evalCase) {
      const recorded = await recordReviewConversation(evalCase);
      const before = await assistantMessageCount(recorded.conversationId);
      const result = await service.review({
        workspaceId: CQ_WORKSPACE_ID,
        agentId: CQ_AGENT_ID,
        conversationId: recorded.conversationId,
        existingUserMessageId: recorded.requestMessageId,
        historyWindow: { maxMessages: recorded.historyLength },
      });
      return observedOutputFromReviewResult(result, (await assistantMessageCount(recorded.conversationId)) - before);
    },
  };

  return { service, port, chatGateway, routineStore, routineProvider, messageRepository, metrics };
};

/**
 * The canonical (non-streaming) answer envelope a grounded turn's model call returns, in
 * schema order: the verdict head, the commitments to the directive rules, the answer, its
 * claims, and the grades.
 */
export const canonicalAnswerEnvelope = (input: {
  coverage: string;
  requestFocus: string;
  outcome: "answer" | "no_support";
  adherencePlan?: Array<{ rule: string; commitment: string }>;
  answer: string;
  claims: number[][];
  grounding: "grounded" | "degraded";
  adherence?: Array<{ rule: string; satisfied: boolean; applicable: boolean; note: string }>;
}): string => JSON.stringify({
  coverage: input.coverage,
  requestFocus: input.requestFocus,
  outcome: input.outcome,
  adherencePlan: input.adherencePlan ?? [],
  answer: input.answer,
  v: 2,
  claims: input.claims,
  suggestions: [],
  grounding: input.grounding,
  adherence: input.adherence ?? [],
});
