import type { ConversationRepositoryPort } from "../../../db/repositories/conversationRepository.js";
import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import {
  NoopProductAnalyticsService,
  type ProductAnalyticsPort,
} from "../../../shared/analytics/productAnalyticsService.js";
import type { AuditService } from "../../audit/services/auditService.js";
import type { RetrievalTrace, RewriteContinuityState } from "../../retrieval/domain/retrievalPipelineTypes.js";
import { RetrievalInfoPresenter } from "../../retrieval/services/retrievalInfoPresenter.js";
import { RetrievalTracePresenter } from "../../retrieval/services/retrievalTracePresenter.js";
import type { RetrievalPipelineService } from "../../retrieval/services/retrievalPipelineService.js";
import type { AnswerSegment, ChatCitation } from "./answerPresentationService.js";
import type {
  AnswerSegmentValidationResult,
  AnswerValidationSummary,
  AssistantTurnOutcome,
} from "./answerSupportValidationTypes.js";
import { assertInteractiveAssistantWorkflow } from "./chatExecutionPolicy.js";
import { buildRewriteContinuityState } from "./rewriteContinuityState.js";
import type { AnswerSupportPolicy, ConversationMode } from "../../settings/domain/retrievalSettings.js";
import type { ChatRoute, ChatSuggestion, ConversationModeMetadata } from "../types/chatResponses.js";

export interface ChatAnswerAuditMetadata {
  workflow?: string;
  executionClass?: string;
  answerOutcome?: AssistantTurnOutcome;
  answerSupportPolicy?: AnswerSupportPolicy;
  conversationMode?: ConversationMode;
  conversationModeMetadata?: ConversationModeMetadata;
  validation?: AnswerValidationSummary & {
    segmentResults?: Array<
      Pick<AnswerSegmentValidationResult, "originalText" | "text" | "disposition" | "replacementApplied" | "reason" | "citationIndices">
    >;
  };
  rewriteContinuityState?: RewriteContinuityState;
  citations?: ChatCitation[];
  answerSegments?: AnswerSegment[];
  suggestions?: ChatSuggestion[];
  retrievalTrace?: RetrievalTrace;
}

type RetrievalResult = Awaited<ReturnType<RetrievalPipelineService["run"]>>;

interface ChatAuditSession {
  conversation: { id: string };
  userMessage: Pick<MessageRecord, "id">;
  retrieval: Pick<RetrievalResult, "contexts" | "diagnostics" | "trace">;
}

export class ChatTurnAuditRecorder {
  private readonly retrievalInfoPresenter = new RetrievalInfoPresenter();
  private readonly retrievalTracePresenter = new RetrievalTracePresenter();

  constructor(
    private readonly conversationRepository: ConversationRepositoryPort,
    private readonly auditService: AuditService,
    private readonly productAnalyticsService: ProductAnalyticsPort = new NoopProductAnalyticsService(),
  ) {}

  async recordSuccess(input: {
    workspaceId: string;
    accountId?: string;
    conversationId: string;
    userMessageId: string;
    assistantMessageId: string;
    answerOutcome: AssistantTurnOutcome;
    validation: AnswerValidationSummary;
    segmentResults: AnswerSegmentValidationResult[];
    citations: ChatCitation[];
    answerSegments?: AnswerSegment[];
    suggestions?: ChatSuggestion[];
    answerSupportPolicy?: AnswerSupportPolicy;
    conversationMode: ConversationMode;
    conversationModeMetadata: ConversationModeMetadata;
    priorRewriteContinuityState?: RewriteContinuityState;
    diagnostics: RetrievalResult["diagnostics"];
    retrievalTrace: RetrievalTrace;
    route: ChatRoute;
    stream: boolean;
  }): Promise<void> {
    const workflowPolicy = assertInteractiveAssistantWorkflow("chat.turn");
    await this.conversationRepository.touch(input.conversationId, input.workspaceId);
    await this.auditService.record({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      eventType: "chat.answer",
      eventStatus: "success",
      metadata: {
        workflow: workflowPolicy.workflow,
        executionClass: workflowPolicy.executionClass,
        conversationId: input.conversationId,
        userMessageId: input.userMessageId,
        assistantMessageId: input.assistantMessageId,
        stream: input.stream,
        answerOutcome: input.answerOutcome,
        route: {
          generator: "assistant",
          routeType: input.route.type,
          routeReason: input.route.reason,
          retrievalInvoked: input.route.type === "retrieval",
        },
        answerSupportPolicy: input.answerSupportPolicy,
        conversationMode: input.conversationMode,
        conversationModeMetadata: input.conversationModeMetadata,
        validation: {
          ...input.validation,
          segmentResults: input.segmentResults.map((segment) => ({
            originalText: segment.originalText,
            text: segment.text,
            disposition: segment.disposition,
            replacementApplied: segment.replacementApplied,
            reason: segment.reason,
            citationIndices: segment.citationIndices,
          })),
        },
        citationCount: input.citations.length,
        citations: input.citations,
        answerSegments: input.answerSegments,
        suggestions: input.suggestions,
        rewriteContinuityState: buildRewriteContinuityState({
          previousState: input.priorRewriteContinuityState,
          diagnostics: input.diagnostics,
          citations: input.citations,
        }),
        retrieval: input.diagnostics,
        retrievalTrace: input.retrievalTrace,
      },
    });
    try {
      await this.productAnalyticsService.track({
        eventName: "chat.completed",
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        subjectType: "conversation",
        subjectId: input.conversationId,
        properties: {
          stream: input.stream,
          answerOutcome: input.answerOutcome,
          conversationMode: input.conversationMode,
          citationCount: input.citations.length,
          suggestionCount: input.suggestions?.length ?? 0,
        },
        source: "backend",
      });
    } catch {
      // Analytics fan-out must not change successful chat behavior.
    }
  }

  async recordFailure(input: {
    workspaceId: string;
    accountId?: string;
    conversationId?: string;
    stream: boolean;
    session: ChatAuditSession | null;
    existingAssistantMessageId?: string;
    route?: ChatRoute;
    error: unknown;
    workflowPolicy?: ReturnType<typeof assertInteractiveAssistantWorkflow>;
  }): Promise<void> {
    const workflowPolicy = input.workflowPolicy ?? assertInteractiveAssistantWorkflow("chat.turn");

    if (input.session && input.existingAssistantMessageId) {
      await this.conversationRepository.touch(input.session.conversation.id, input.workspaceId);
    }

    await this.auditService.record({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      eventType: "chat.answer",
      eventStatus: "failure",
      metadata: {
        stage: "chat.answer",
        workflow: workflowPolicy.workflow,
        executionClass: workflowPolicy.executionClass,
        conversationId: input.session?.conversation.id ?? input.conversationId,
        userMessageId: input.session?.userMessage.id,
        assistantMessageId: input.existingAssistantMessageId,
        stream: input.stream,
        citationCount: 0,
        retrieval: input.session?.retrieval.diagnostics,
        retrievalTrace: input.session && input.route
          ? this.retrievalTracePresenter.appendAnswerOutcome({
              trace: input.session.retrieval.trace,
              summary: this.retrievalInfoPresenter.present(input.session.retrieval.diagnostics, {
                execution: {
                  surface: "assistant",
                  path: input.route.type === "direct" ? "assistant_direct" : "assistant_retrieval",
                  retrievalInvoked: input.route.type === "retrieval",
                },
              }),
              outcome: {
                answer: "",
                stream: input.stream,
                hadContexts: input.session.retrieval.contexts.length > 0,
                retrievalSkipped: input.session.retrieval.diagnostics.retrievalSkipped,
                durationMs: 0,
              },
            })
          : undefined,
        errorMessage: input.error instanceof Error ? input.error.message : "Unknown error",
      },
    });
    try {
      await this.productAnalyticsService.track({
        eventName: "chat.failed",
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        subjectType: "conversation",
        subjectId: input.session?.conversation.id ?? input.conversationId,
        properties: {
          stream: input.stream,
          errorMessage: input.error instanceof Error ? input.error.message : "Unknown error",
        },
        source: "backend",
      });
    } catch {
      // Analytics fan-out must not change failure behavior.
    }
  }
}
