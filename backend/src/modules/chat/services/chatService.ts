import { notFound } from "../../../shared/domain/errors.js";
import { RETRIEVAL_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import { normalizeProviderCredentialError } from "../../../shared/infra/llm/providerErrors.js";
import type { TextGenerationClient } from "../../../shared/infra/llm/providerTypes.js";
import type { AuditService } from "../../audit/services/auditService.js";
import type { ConversationRepositoryPort } from "../../../db/repositories/conversationRepository.js";
import type { MessageRecord, MessageRepositoryPort } from "../../../db/repositories/messageRepository.js";
import type { WorkspaceRepositoryPort } from "../../../db/repositories/workspaceRepository.js";
import type { ResponseIdentity } from "../../../shared/domain/responseIdentity.js";
import { RetrievalInfoPresenter, type RetrievalInfo } from "../../retrieval/services/retrievalInfoPresenter.js";
import { RetrievalTracePresenter } from "../../retrieval/services/retrievalTracePresenter.js";
import type { RetrievalPipelineService } from "../../retrieval/services/retrievalPipelineService.js";
import type { AnswerSegment, ChatCitation } from "./answerPresentationService.js";
import { CitationAnchorSanitizer } from "./citationAnchorSanitizer.js";
import {
  MissingGroundedMissResponseComposer,
  type GroundedMissResponseComposer,
} from "./groundedMissResponseComposer.js";
import { assertInteractiveAssistantWorkflow } from "./chatExecutionPolicy.js";
import type { ConversationMode } from "../../settings/domain/retrievalSettings.js";
import type { RetrievalTrace, RewriteContinuityState } from "../../retrieval/domain/retrievalPipelineTypes.js";
import type { ChatResponse, ChatRoute, ChatSuggestion, ConversationModeMetadata } from "../types/chatResponses.js";
import type { UserMessageInputMetadata } from "../../../db/repositories/messageRepository.js";
import { CHAT_TURN_ROUTE, ChatTurnIntentService, type ChatTurnRoute } from "./chatTurnIntentService.js";
import {
  NoopProductAnalyticsService,
  type ProductAnalyticsPort,
} from "../../../shared/analytics/productAnalyticsService.js";
import { ChatTurnAuditRecorder, type ChatAnswerAuditMetadata } from "./chatTurnAuditRecorder.js";
import { normalizeRewriteContinuityState } from "./rewriteContinuityState.js";
import { ChatAnswerPresentationFlow } from "./chatAnswerPresentationFlow.js";
import type { PreparedSession, PresentedAnswer } from "./chatTurnTypes.js";

export interface ChatGateway {
  answer(input: {
    query: string;
    history: MessageRecord[];
    prompt: string;
    systemPrompt?: string;
  }): Promise<string>;
  streamAnswer(input: {
    query: string;
    history: MessageRecord[];
    prompt: string;
    systemPrompt?: string;
  }): AsyncIterable<string>;
}

export class BlankChatAnswerError extends Error {
  constructor() {
    super("chat_answer_generation_failed");
    this.name = "BlankChatAnswerError";
  }
}

type ChatIntentCapableRetrievalPipeline = Pick<RetrievalPipelineService, "run" | "interpret" | "runInterpreted" | "runWithoutRetrieval">;

export type ChatStreamEvent =
  | { type: "conversation"; conversationId: string }
  | { type: "chunk"; text: string }
  | {
      type: "suggestions";
      conversationId: string;
      suggestions: ChatSuggestion[];
      conversationModeMetadata: ConversationModeMetadata;
    }
  | {
      type: "done";
      conversationId: string;
      answer: string;
      citations?: ChatCitation[];
      answerSegments?: AnswerSegment[];
      suggestions?: ChatSuggestion[];
      conversationMode: ConversationMode;
      conversationModeMetadata: ConversationModeMetadata;
      retrievalInfo: RetrievalInfo;
      retrievalTrace: RetrievalTrace;
      route: ChatRoute;
    };

interface FinalizedPresentedAnswer extends ChatResponse {
  assistantMessageId: string;
}

export class ModelChatGateway implements ChatGateway {
  constructor(private readonly client: TextGenerationClient) {}

  async answer(input: { query: string; history: MessageRecord[]; prompt: string; systemPrompt?: string }): Promise<string> {
    const response = await this.client.complete({
      systemPrompt: input.systemPrompt,
      prompt: input.prompt,
    });

    if (!response?.trim()) {
      throw new BlankChatAnswerError();
    }

    return response;
  }

  async *streamAnswer(input: { query: string; history: MessageRecord[]; prompt: string; systemPrompt?: string }): AsyncIterable<string> {
    for await (const chunk of this.client.stream({
      systemPrompt: input.systemPrompt,
      prompt: input.prompt,
    })) {
      if (chunk.length > 0) {
        yield chunk;
      }
    }
  }
}

export class OpenAIChatGateway extends ModelChatGateway {}

export class ChatService {
  private readonly retrievalInfoPresenter = new RetrievalInfoPresenter();
  private readonly retrievalTracePresenter = new RetrievalTracePresenter();
  private readonly chatTurnIntentService = new ChatTurnIntentService();
  private readonly chatTurnAuditRecorder: ChatTurnAuditRecorder;
  private readonly answerPresentationFlow: ChatAnswerPresentationFlow;
  constructor(
    private readonly conversationRepository: ConversationRepositoryPort,
    private readonly messageRepository: MessageRepositoryPort,
    private readonly retrievalPipeline: RetrievalPipelineService,
    private readonly chatGateway: ChatGateway,
    private readonly auditService: AuditService,
    private readonly groundedMissResponseComposer: GroundedMissResponseComposer = new MissingGroundedMissResponseComposer(),
    productAnalyticsService: ProductAnalyticsPort = new NoopProductAnalyticsService(),
    private readonly workspaceRepository?: Pick<WorkspaceRepositoryPort, "findById">,
  ) {
    this.chatTurnAuditRecorder = new ChatTurnAuditRecorder(
      conversationRepository,
      auditService,
      productAnalyticsService,
    );
    this.answerPresentationFlow = new ChatAnswerPresentationFlow(chatGateway, groundedMissResponseComposer);
  }

  private async resolveResponseIdentity(workspaceId: string): Promise<ResponseIdentity | null> {
    if (!this.workspaceRepository) {
      return null;
    }

    const workspace = await this.workspaceRepository.findById(workspaceId);
    if (!workspace) {
      return null;
    }

    const name = workspace.assistantName.trim();
    const role = workspace.assistantRole.trim();
    return name || role
      ? {
          name: name || undefined,
          role: role || undefined,
        }
      : null;
  }

  private getRoute(session: PreparedSession): ChatRoute {
    if (session.turnRoute !== CHAT_TURN_ROUTE.RETRIEVAL) {
      return {
        type: "direct",
        reason: session.retrieval.diagnostics.responseIntent === "assistant_identity"
          ? "assistant_identity"
          : "social_only",
      };
    }

    return {
      type: "retrieval",
      reason: "evidence_required",
    };
  }

  async answer(input: {
    workspaceId: string;
    accountId?: string;
    conversationId?: string;
    query: string;
    stream: boolean;
    userExpectedLocale?: string | null;
    inputMetadata?: UserMessageInputMetadata;
    metadataFilter?: Record<string, unknown>;
    sourceChannel?: string | null;
    anonymousSessionId?: string | null;
    sourceOrigin?: string | null;
  }): Promise<ChatResponse> {
    let session: PreparedSession | null = null;
    let assistantMessageId: string | undefined;
    const workflowPolicy = assertInteractiveAssistantWorkflow("chat.turn");

    try {
      session = await this.prepareSession(input);
      const answerStartedAt = Date.now();
      const presentation = await this.answerPresentationFlow.generateAnswerPresentation(session, input.query, input.userExpectedLocale);
      const finalized = await this.finalizePresentedAnswer({
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        stream: input.stream,
        session,
        presentation,
        answerStartedAt,
      });
      assistantMessageId = finalized.assistantMessageId;

      return finalized;
    } catch (error) {
      const normalizedError = normalizeProviderCredentialError(error);
      await this.chatTurnAuditRecorder.recordFailure({
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        conversationId: input.conversationId,
        stream: input.stream,
        session,
        existingAssistantMessageId: assistantMessageId,
        route: session ? this.getRoute(session) : undefined,
        error: normalizedError,
        workflowPolicy,
      });
      throw normalizedError;
    }
  }

  async *streamAnswer(input: {
    workspaceId: string;
    accountId?: string;
    conversationId?: string;
    query: string;
    stream: boolean;
    userExpectedLocale?: string | null;
    inputMetadata?: UserMessageInputMetadata;
    metadataFilter?: Record<string, unknown>;
    sourceChannel?: string | null;
    anonymousSessionId?: string | null;
    sourceOrigin?: string | null;
  }): AsyncIterable<ChatStreamEvent> {
    let session: PreparedSession | null = null;
    let assistantMessageId: string | undefined;
    let lazySuggestionsPromise:
      | Promise<Pick<PresentedAnswer, "suggestions" | "conversationModeMetadata">>
      | undefined;
    const workflowPolicy = assertInteractiveAssistantWorkflow("chat.turn");

    try {
      session = await this.prepareSession(input);

      yield {
        type: "conversation",
        conversationId: session.conversation.id,
      };

      let rawAnswer = "";
      let noContextPresentation: PresentedAnswer | null = null;
      const answerStartedAt = Date.now();

      if (session.turnRoute !== CHAT_TURN_ROUTE.RETRIEVAL) {
        noContextPresentation = await this.answerPresentationFlow.generateNonRetrievalAnswer(session, input.query);
        rawAnswer = noContextPresentation?.answer
          ?? await this.groundedMissResponseComposer.composeNoContext({
            query: input.query,
            conversationMode: this.answerPresentationFlow.getConversationMode(session),
            userExpectedLocale: input.userExpectedLocale,
          });
        yield {
          type: "chunk",
          text: rawAnswer,
        };
      } else if (session.retrieval.contexts.length === 0) {
        rawAnswer = await this.groundedMissResponseComposer.composeNoContext({
          query: input.query,
          conversationMode: this.answerPresentationFlow.getConversationMode(session),
          userExpectedLocale: input.userExpectedLocale,
        });
        yield {
          type: "chunk",
          text: rawAnswer,
        };
      } else {
        const sanitizer = new CitationAnchorSanitizer();
        for await (const text of this.chatGateway.streamAnswer({
          query: input.query,
          history: session.history,
          systemPrompt: session.retrieval.systemPrompt,
          prompt: session.retrieval.prompt,
        })) {
          if (!text) {
            continue;
          }
          rawAnswer = `${rawAnswer}${text}`;
          const safe = sanitizer.push(text);
          if (!safe) {
            continue;
          }
          if (safe.trim().length === 0 && rawAnswer.trim().length === 0) {
            continue;
          }
          yield {
            type: "chunk",
            text: safe,
          };
        }

        const trailing = sanitizer.flush();
        if (trailing) {
          yield {
            type: "chunk",
            text: trailing,
          };
        }

        if (!rawAnswer.trim()) {
          throw new BlankChatAnswerError();
        }
      }

      const presentationWithoutSuggestions = noContextPresentation ?? await this.answerPresentationFlow.presentAnswerWithoutSuggestions(
        session,
        rawAnswer,
        input.query,
        input.userExpectedLocale,
      );
      lazySuggestionsPromise = noContextPresentation
        ? Promise.resolve({
            suggestions: noContextPresentation.suggestions,
            conversationModeMetadata: noContextPresentation.conversationModeMetadata,
          })
        : this.answerPresentationFlow.applyConversationMode(session, presentationWithoutSuggestions);
      const presentation: PresentedAnswer = {
        ...presentationWithoutSuggestions,
        suggestions: undefined,
        conversationModeMetadata: noContextPresentation?.conversationModeMetadata ?? this.answerPresentationFlow.getConversationModeMetadata(session),
      };
      const finalized = await this.finalizePresentedAnswer({
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        stream: input.stream,
        session,
        presentation,
        answerStartedAt,
      });
      assistantMessageId = finalized.assistantMessageId;

      yield {
        type: "done",
        conversationId: finalized.conversationId,
        route: finalized.route,
        answer: finalized.answer,
        citations: finalized.citations,
        answerSegments: finalized.answerSegments,
        suggestions: undefined,
        conversationMode: finalized.conversationMode,
        conversationModeMetadata: finalized.conversationModeMetadata,
        retrievalInfo: finalized.retrievalInfo,
        retrievalTrace: finalized.retrievalTrace,
      };

    } catch (error) {
      const normalizedError = normalizeProviderCredentialError(error);
      await this.chatTurnAuditRecorder.recordFailure({
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        conversationId: input.conversationId,
        stream: input.stream,
        session,
        existingAssistantMessageId: assistantMessageId,
        route: session ? this.getRoute(session) : undefined,
        error: normalizedError,
        workflowPolicy,
      });
      throw normalizedError;
    }

    try {
      const lazySuggestions = await lazySuggestionsPromise;
      if (lazySuggestions.suggestions && lazySuggestions.suggestions.length > 0) {
        if (assistantMessageId) {
          await this.auditService.updateChatAnswerSuggestions({
            workspaceId: input.workspaceId,
            conversationId: session.conversation.id,
            assistantMessageId,
            suggestions: lazySuggestions.suggestions,
            conversationModeMetadata: lazySuggestions.conversationModeMetadata,
          });
        }

        yield {
          type: "suggestions",
          conversationId: session.conversation.id,
          suggestions: lazySuggestions.suggestions,
          conversationModeMetadata: lazySuggestions.conversationModeMetadata,
        };
      }
    } catch {
      // Lazy follow-up suggestions are best effort after the answer is already complete.
    }
  }

  private async prepareSession(input: {
    workspaceId: string;
    accountId?: string;
    conversationId?: string;
    query: string;
    inputMetadata?: UserMessageInputMetadata;
    metadataFilter?: Record<string, unknown>;
    sourceChannel?: string | null;
    anonymousSessionId?: string | null;
    sourceOrigin?: string | null;
  }): Promise<PreparedSession> {
    const conversation = input.conversationId
      ? await this.ensureConversation(input.conversationId, input.workspaceId, input.anonymousSessionId)
      : null;
    const history = conversation
      ? await this.messageRepository.listRecentByConversationId(
          input.workspaceId,
          conversation.id,
          RETRIEVAL_BEHAVIOR.rewriteConversationContextMaxMessages,
        )
      : [];
    const rewriteContinuityState = conversation
      ? await this.loadRewriteContinuityState(input.workspaceId, conversation.id)
      : undefined;
    const responseIdentity = await this.resolveResponseIdentity(input.workspaceId);
    const pipelineInput = {
      workspaceId: input.workspaceId,
      query: input.query,
      history,
      responseIdentity,
      responseBehaviorEnabled: true,
      metadataFilter: input.metadataFilter,
    };
    let retrieval: Awaited<ReturnType<RetrievalPipelineService["run"]>>;
    let turnRoute: ChatTurnRoute = CHAT_TURN_ROUTE.RETRIEVAL;

    const retrievalPipeline = this.retrievalPipeline as ChatIntentCapableRetrievalPipeline;
    const interpretation = await retrievalPipeline.interpret(pipelineInput);
    turnRoute = this.chatTurnIntentService.resolve({
      responseIntent: interpretation.interpretation.result.responseIntent,
    });
    retrieval = turnRoute === CHAT_TURN_ROUTE.RETRIEVAL
      ? await retrievalPipeline.runInterpreted(interpretation)
      : await retrievalPipeline.runWithoutRetrieval(interpretation);
    const persistedConversation =
      conversation ?? await this.conversationRepository.create(
        input.workspaceId,
        input.sourceChannel ?? null,
        input.anonymousSessionId ?? null,
        input.sourceOrigin ?? null,
      );

    const userMessage = await this.messageRepository.create({
      conversationId: persistedConversation.id,
      workspaceId: input.workspaceId,
      role: "user",
      content: input.query,
      inputMetadata: input.inputMetadata,
    });

    return {
      conversation: persistedConversation,
      history,
      retrieval,
      turnRoute,
      userMessage,
      priorRewriteContinuityState: rewriteContinuityState,
    };
  }

  private async finalizePresentedAnswer(input: {
    workspaceId: string;
    accountId?: string;
    stream: boolean;
    session: PreparedSession;
    presentation: PresentedAnswer;
    answerStartedAt: number;
  }): Promise<FinalizedPresentedAnswer> {
    const route = this.getRoute(input.session);
    const retrievalInfo = this.retrievalInfoPresenter.present(input.session.retrieval.diagnostics, {
      execution: {
        surface: "assistant",
        path: route.type === "direct" ? "assistant_direct" : "assistant_retrieval",
        retrievalInvoked: route.type === "retrieval",
      },
    });
    const retrievalTrace = this.retrievalTracePresenter.appendAnswerOutcome({
      trace: input.session.retrieval.trace,
      summary: retrievalInfo,
      outcome: {
        answer: input.presentation.answer,
        stream: input.stream,
        hadContexts: input.session.retrieval.contexts.length > 0,
        retrievalSkipped: input.session.retrieval.diagnostics.retrievalSkipped,
        durationMs: Date.now() - input.answerStartedAt,
        answerOutcome: input.presentation.answerOutcome,
        validation: input.presentation.validation,
      },
    });

    const assistantMessage = await this.messageRepository.create({
      conversationId: input.session.conversation.id,
      workspaceId: input.workspaceId,
      role: "assistant",
      content: input.presentation.answer,
    });

    await this.chatTurnAuditRecorder.recordSuccess({
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      conversationId: input.session.conversation.id,
      userMessageId: input.session.userMessage.id,
      assistantMessageId: assistantMessage.id,
      answerOutcome: input.presentation.answerOutcome,
      validation: input.presentation.validation,
      segmentResults: input.presentation.segmentResults,
      citations: input.presentation.citations ?? [],
      answerSegments: input.presentation.answerSegments,
      suggestions: input.presentation.suggestions,
      answerSupportPolicy: input.presentation.validation.answerSupportPolicy,
      conversationMode: input.presentation.conversationModeMetadata.conversationMode,
      conversationModeMetadata: input.presentation.conversationModeMetadata,
      priorRewriteContinuityState: input.session.priorRewriteContinuityState,
      diagnostics: input.session.retrieval.diagnostics,
      retrievalTrace,
      route,
      stream: input.stream,
    });

    return {
      assistantMessageId: assistantMessage.id,
      conversationId: input.session.conversation.id,
      route,
      answer: input.presentation.answer,
      citations: input.presentation.citations,
      answerSegments: input.presentation.answerSegments,
      suggestions: input.presentation.suggestions,
      conversationMode: input.presentation.conversationModeMetadata.conversationMode,
      conversationModeMetadata: input.presentation.conversationModeMetadata,
      retrievalInfo,
      retrievalTrace,
    };
  }

  private async ensureConversation(conversationId: string, workspaceId: string, anonymousSessionId?: string | null) {
    // When an anonymous session is provided, verify the conversation belongs to that session
    if (anonymousSessionId) {
      const conversation = await this.conversationRepository.findByIdAndAnonymousSession(
        conversationId,
        workspaceId,
        anonymousSessionId,
      );
      if (!conversation) {
        throw notFound("Conversation not found");
      }
      return conversation;
    }

    const conversation = await this.conversationRepository.findByIdAndWorkspaceId(conversationId, workspaceId);

    if (!conversation) {
      throw notFound("Conversation not found");
    }

    return conversation;
  }

  private async loadRewriteContinuityState(
    workspaceId: string,
    conversationId: string,
  ): Promise<RewriteContinuityState | undefined> {
    const metadata = await this.auditService.getLatestSuccessfulChatAnswerMetadata({
      workspaceId,
      conversationId,
    }) as ChatAnswerAuditMetadata | null;

    return normalizeRewriteContinuityState(metadata?.rewriteContinuityState);
  }
}
