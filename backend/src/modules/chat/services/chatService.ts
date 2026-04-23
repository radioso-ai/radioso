import { notFound } from "../../../shared/domain/errors.js";
import { CHAT_BEHAVIOR, RETRIEVAL_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import { normalizeProviderCredentialError } from "../../../shared/infra/llm/providerErrors.js";
import type { TextGenerationClient } from "../../../shared/infra/llm/providerTypes.js";
import { renderPromptTemplate } from "../../../shared/infra/prompts/promptLoader.js";
import type { AuditService } from "../../audit/services/auditService.js";
import type { ConversationRecord, ConversationRepositoryPort } from "../../../db/repositories/conversationRepository.js";
import type { MessageRecord, MessageRepositoryPort } from "../../../db/repositories/messageRepository.js";
import { RetrievalInfoPresenter, type RetrievalInfo } from "../../retrieval/services/retrievalInfoPresenter.js";
import { RetrievalTracePresenter } from "../../retrieval/services/retrievalTracePresenter.js";
import type { RetrievalPipelineService } from "../../retrieval/services/retrievalPipelineService.js";
import { AnswerPresentationService, type AnswerSegment, type ChatCitation } from "./answerPresentationService.js";
import { AnswerSupportValidator } from "./answerSupportValidator.js";
import {
  ASSISTANT_TURN_OUTCOME,
  type AnswerSegmentValidationResult,
  type AnswerValidationSummary,
  type AssistantTurnOutcome,
} from "./answerSupportValidationTypes.js";
import { AssistantTurnOutcomeClassifier } from "./assistantTurnOutcomeClassifier.js";
import { CitationAnchorSanitizer } from "./citationAnchorSanitizer.js";
import {
  MissingGroundedMissResponseComposer,
  type GroundedMissResponseComposer,
} from "./groundedMissResponseComposer.js";
import { assertInteractiveAssistantWorkflow } from "./chatExecutionPolicy.js";
import { ConversationModeExpansionService } from "./conversationModeExpansionService.js";
import type { AnswerSupportPolicy, ConversationMode } from "../../settings/domain/retrievalSettings.js";
import { DEFAULT_ANSWER_SUPPORT_POLICY } from "../../settings/domain/retrievalSettings.js";
import type { RetrievalTrace, RewriteContinuityState } from "../../retrieval/domain/retrievalPipelineTypes.js";
import { shouldReplaceUnsupportedSegments } from "./answerSupportPolicy.js";
import type { ChatResponse, ChatSuggestion, ConversationModeMetadata } from "../types/chatResponses.js";
import type { AssistantIdentityPromptInput } from "../../settings/domain/assistantBootstrapSettings.js";
import type { UserMessageInputMetadata } from "../../../db/repositories/messageRepository.js";
import { buildConversationIntentSnapshot } from "./conversationIntentSnapshot.js";
import {
  NoopProductAnalyticsService,
  type ProductAnalyticsPort,
} from "../../../shared/analytics/productAnalyticsService.js";

export interface ChatGateway {
  answer(input: {
    query: string;
    history: MessageRecord[];
    prompt: string;
  }): Promise<string>;
  streamAnswer(input: {
    query: string;
    history: MessageRecord[];
    prompt: string;
  }): AsyncIterable<string>;
}

export class BlankChatAnswerError extends Error {
  constructor() {
    super("chat_answer_generation_failed");
    this.name = "BlankChatAnswerError";
  }
}

const isBlankChatAnswerError = (error: unknown): error is BlankChatAnswerError => error instanceof BlankChatAnswerError;

const DIRECT_ANSWER_PATTERNS = [
  /\bjust the answer\b/i,
  /\bjust answer\b/i,
  /\bbriefly\b/i,
  /\bbe brief\b/i,
  /\bshort answer\b/i,
  /\bone sentence\b/i,
  /\bconcise\b/i,
  /\bsuccinct\b/i,
  /\bno follow[- ]up\b/i,
  /\bwithout extra detail/i,
  /\bsolo la risposta\b/i,
  /\bin breve\b/i,
];

const shouldSuppressOptionalSuggestions = (query: string): boolean =>
  DIRECT_ANSWER_PATTERNS.some((pattern) => pattern.test(query));

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
    };

interface PreparedSession {
  conversation: ConversationRecord;
  history: MessageRecord[];
  retrieval: Awaited<ReturnType<RetrievalPipelineService["run"]>>;
  userMessage: MessageRecord;
  priorRewriteContinuityState?: RewriteContinuityState;
}

interface ChatAnswerAuditMetadata {
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

interface PresentedAnswer {
  answer: string;
  citations?: ChatCitation[];
  answerSegments?: AnswerSegment[];
  suggestions?: ChatSuggestion[];
  planningCitations?: ChatCitation[];
  answerOutcome: AssistantTurnOutcome;
  validation: AnswerValidationSummary;
  segmentResults: AnswerSegmentValidationResult[];
  conversationModeMetadata: ConversationModeMetadata;
}

const inferConversationModeMetadata = (input: {
  conversationMode: ConversationMode;
  brevityOverrideApplied: boolean;
  suggestionCount: number;
  followUpQuestionApplied?: boolean;
}): Omit<ConversationModeMetadata, "conversationMode" | "brevityOverrideApplied"> => {
  if (input.brevityOverrideApplied) {
    return {
      expansionApplied: false,
      expansionKind: "none",
      suggestionCount: 0,
      followUpQuestionApplied: false,
    };
  }

  const expansionApplied = input.suggestionCount > 0;
  if (!expansionApplied) {
    return {
      expansionApplied: false,
      expansionKind: "none",
      suggestionCount: 0,
      followUpQuestionApplied: Boolean(input.followUpQuestionApplied),
    };
  }

  return {
    expansionApplied: true,
    expansionKind: input.conversationMode === "exploratory" ? "expansive" : "focused",
    suggestionCount: input.suggestionCount,
    followUpQuestionApplied: Boolean(input.followUpQuestionApplied),
  };
};

export class ModelChatGateway implements ChatGateway {
  constructor(private readonly client: TextGenerationClient) {}

  async answer(input: { query: string; history: MessageRecord[]; prompt: string }): Promise<string> {
    const response = await this.client.complete({
      prompt: input.prompt,
    });

    if (!response?.trim()) {
      throw new BlankChatAnswerError();
    }

    return response;
  }

  async *streamAnswer(input: { query: string; history: MessageRecord[]; prompt: string }): AsyncIterable<string> {
    for await (const chunk of this.client.stream({
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
  private readonly answerPresentationService = new AnswerPresentationService();
  private readonly answerSupportValidator = new AnswerSupportValidator();
  private readonly assistantTurnOutcomeClassifier = new AssistantTurnOutcomeClassifier();
  private readonly retrievalInfoPresenter = new RetrievalInfoPresenter();
  private readonly retrievalTracePresenter = new RetrievalTracePresenter();
  private readonly conversationModeExpansionService: ConversationModeExpansionService;
  constructor(
    private readonly conversationRepository: ConversationRepositoryPort,
    private readonly messageRepository: MessageRepositoryPort,
    private readonly retrievalPipeline: RetrievalPipelineService,
    private readonly chatGateway: ChatGateway,
    private readonly auditService: AuditService,
    private readonly groundedMissResponseComposer: GroundedMissResponseComposer = new MissingGroundedMissResponseComposer(),
    private readonly productAnalyticsService: ProductAnalyticsPort = new NoopProductAnalyticsService(),
  ) {
    this.conversationModeExpansionService = new ConversationModeExpansionService(async ({ query, history, prompt }) =>
      this.chatGateway.answer({
        query,
        history,
        prompt,
      }));
  }

  private getAnswerSupportPolicy(session: PreparedSession): AnswerSupportPolicy {
    return session.retrieval.responseSettings?.answerSupportPolicy ?? DEFAULT_ANSWER_SUPPORT_POLICY;
  }

  private getConversationMode(session: PreparedSession): ConversationMode {
    return session.retrieval.responseSettings?.conversationMode ?? "guided";
  }

  private getSuggestedQuestionsEnabled(session: PreparedSession): boolean {
    return session.retrieval.responseSettings?.suggestedQuestionsEnabled ?? true;
  }

  private getSuggestedQuestionsCount(session: PreparedSession): number {
    return session.retrieval.responseSettings?.suggestedQuestionsCount ?? 3;
  }

  private getConversationModeMetadata(session: PreparedSession, input?: Partial<ConversationModeMetadata>): ConversationModeMetadata {
    return {
      conversationMode: this.getConversationMode(session),
      brevityOverrideApplied: false,
      expansionApplied: false,
      expansionKind: "none",
      suggestionCount: 0,
      followUpQuestionApplied: false,
      ...input,
    };
  }

  private async generateIdentityAnswer(
    session: PreparedSession,
    query: string,
  ): Promise<PresentedAnswer | null> {
    if (!isAssistantIdentityQuestion(query) || !session.retrieval.assistantIdentity) {
      return null;
    }

    let answer: string;
    try {
      answer = (await this.chatGateway.answer({
        query,
        history: session.history,
        prompt: buildAssistantIdentityAnswerPrompt({
          assistantIdentity: session.retrieval.assistantIdentity,
          history: session.history,
          query,
        }),
      })).trim();
    } catch (error) {
      if (isBlankChatAnswerError(error)) {
        return null;
      }
      throw error;
    }

    if (!answer) {
      return null;
    }

    const presented = this.answerPresentationService.present({
      answer,
      citations: [],
      citationDisplayEnabled: false,
    });

    return {
      ...presented,
      planningCitations: [],
      answerOutcome: ASSISTANT_TURN_OUTCOME.GROUNDED_SUCCESS,
      validation: {
        ran: false,
        answerModified: false,
        unsupportedSegmentCount: 0,
        substantiveUnsupportedSegmentCount: 0,
        supportedSegmentCount: 0,
        nonSubstantiveSegmentCount: 0,
        answerSupportPolicy: this.getAnswerSupportPolicy(session),
      },
      segmentResults: [],
      conversationModeMetadata: this.getConversationModeMetadata(session),
    };
  }

  async answer(input: {
    workspaceId: string;
    accountId?: string;
    conversationId?: string;
    query: string;
    stream: boolean;
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
      const presentation = await this.generateAnswerPresentation(session, input.query);
      const retrievalInfo = this.retrievalInfoPresenter.present(session.retrieval.diagnostics);
      const retrievalTrace = this.retrievalTracePresenter.appendAnswerOutcome({
        trace: session.retrieval.trace,
        summary: retrievalInfo,
        outcome: {
          answer: presentation.answer,
          stream: input.stream,
          hadContexts: session.retrieval.contexts.length > 0,
          durationMs: Date.now() - answerStartedAt,
          answerOutcome: presentation.answerOutcome,
          validation: presentation.validation,
        },
      });

      const assistantMessage = await this.messageRepository.create({
        conversationId: session.conversation.id,
        workspaceId: input.workspaceId,
        role: "assistant",
        content: presentation.answer,
      });
      assistantMessageId = assistantMessage.id;
      await this.finalizeAssistantTurn({
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        conversationId: session.conversation.id,
        userMessageId: session.userMessage.id,
        assistantMessageId,
        answerOutcome: presentation.answerOutcome,
        validation: presentation.validation,
        segmentResults: presentation.segmentResults,
        citations: presentation.citations ?? [],
        answerSegments: presentation.answerSegments,
        suggestions: presentation.suggestions,
        answerSupportPolicy: presentation.validation.answerSupportPolicy,
        conversationMode: presentation.conversationModeMetadata.conversationMode,
        conversationModeMetadata: presentation.conversationModeMetadata,
        priorRewriteContinuityState: session.priorRewriteContinuityState,
        diagnostics: session.retrieval.diagnostics,
        retrievalTrace,
        stream: input.stream,
      });

      return {
        conversationId: session.conversation.id,
        answer: presentation.answer,
        citations: presentation.citations,
        answerSegments: presentation.answerSegments,
        suggestions: presentation.suggestions,
        conversationMode: presentation.conversationModeMetadata.conversationMode,
        conversationModeMetadata: presentation.conversationModeMetadata,
        retrievalInfo,
        retrievalTrace,
      };
    } catch (error) {
      const normalizedError = normalizeProviderCredentialError(error);
      await this.recordFailure(input, session, assistantMessageId, normalizedError, workflowPolicy);
      throw normalizedError;
    }
  }

  async *streamAnswer(input: {
    workspaceId: string;
    accountId?: string;
    conversationId?: string;
    query: string;
    stream: boolean;
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
      const answerSupportPolicy = this.getAnswerSupportPolicy(session);
      const suppressRawStreaming =
        session.retrieval.contexts.length > 0 && shouldReplaceUnsupportedSegments(answerSupportPolicy);

      if (session.retrieval.contexts.length === 0) {
        noContextPresentation = await this.generateIdentityAnswer(session, input.query);
        rawAnswer = noContextPresentation?.answer
          ?? await this.groundedMissResponseComposer.composeNoContext({
            query: input.query,
            conversationMode: this.getConversationMode(session),
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
          prompt: session.retrieval.prompt,
        })) {
          if (!text) {
            continue;
          }
          rawAnswer = `${rawAnswer}${text}`;
          const safe = sanitizer.push(text);
          if (!safe || suppressRawStreaming) {
            continue;
          }
          yield {
            type: "chunk",
            text: safe,
          };
        }

        const trailing = sanitizer.flush();
        if (trailing && !suppressRawStreaming) {
          yield {
            type: "chunk",
            text: trailing,
          };
        }

        if (!rawAnswer.trim()) {
          throw new BlankChatAnswerError();
        }
      }

      const presentationWithoutSuggestions = noContextPresentation ?? await this.presentAnswerWithoutSuggestions(
        session,
        rawAnswer,
        input.query,
      );
      lazySuggestionsPromise = noContextPresentation
        ? Promise.resolve({
            suggestions: noContextPresentation.suggestions,
            conversationModeMetadata: noContextPresentation.conversationModeMetadata,
          })
        : this.applyConversationMode(session, presentationWithoutSuggestions);
      const presentation: PresentedAnswer = {
        ...presentationWithoutSuggestions,
        suggestions: undefined,
        conversationModeMetadata: noContextPresentation?.conversationModeMetadata ?? this.getConversationModeMetadata(session),
      };

      if (suppressRawStreaming && presentation.answer.length > 0) {
        yield {
          type: "chunk",
          text: presentation.answer,
        };
      }

      const retrievalInfo = this.retrievalInfoPresenter.present(session.retrieval.diagnostics);
      const retrievalTrace = this.retrievalTracePresenter.appendAnswerOutcome({
        trace: session.retrieval.trace,
        summary: retrievalInfo,
        outcome: {
          answer: presentation.answer,
          stream: input.stream,
          hadContexts: session.retrieval.contexts.length > 0,
          durationMs: Date.now() - answerStartedAt,
          answerOutcome: presentation.answerOutcome,
          validation: presentation.validation,
        },
      });

      const assistantMessage = await this.messageRepository.create({
        conversationId: session.conversation.id,
        workspaceId: input.workspaceId,
        role: "assistant",
        content: presentation.answer,
      });
      assistantMessageId = assistantMessage.id;
      await this.finalizeAssistantTurn({
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        conversationId: session.conversation.id,
        userMessageId: session.userMessage.id,
        assistantMessageId,
        answerOutcome: presentation.answerOutcome,
        validation: presentation.validation,
        segmentResults: presentation.segmentResults,
        citations: presentation.citations ?? [],
        answerSegments: presentation.answerSegments,
        suggestions: presentation.suggestions,
        answerSupportPolicy: presentation.validation.answerSupportPolicy,
        conversationMode: presentation.conversationModeMetadata.conversationMode,
        conversationModeMetadata: presentation.conversationModeMetadata,
        priorRewriteContinuityState: session.priorRewriteContinuityState,
        diagnostics: session.retrieval.diagnostics,
        retrievalTrace,
        stream: input.stream,
      });

      yield {
        type: "done",
        conversationId: session.conversation.id,
        answer: presentation.answer,
        citations: presentation.citations,
        answerSegments: presentation.answerSegments,
        suggestions: undefined,
        conversationMode: presentation.conversationModeMetadata.conversationMode,
        conversationModeMetadata: presentation.conversationModeMetadata,
        retrievalInfo,
        retrievalTrace,
      };

    } catch (error) {
      const normalizedError = normalizeProviderCredentialError(error);
      await this.recordFailure(input, session, assistantMessageId, normalizedError, workflowPolicy);
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
    const retrieval = await this.retrievalPipeline.run({
      workspaceId: input.workspaceId,
      query: input.query,
      history,
      metadataFilter: input.metadataFilter,
    });
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
      userMessage,
      priorRewriteContinuityState: rewriteContinuityState,
    };
  }

  private async generateAnswerPresentation(
    session: PreparedSession,
    query: string,
  ): Promise<PresentedAnswer> {
    if (session.retrieval.contexts.length === 0) {
      const identityAnswer = await this.generateIdentityAnswer(session, query);
      if (identityAnswer) {
        return identityAnswer;
      }
    }

    const answer = session.retrieval.contexts.length === 0
      ? await this.groundedMissResponseComposer.composeNoContext({
          query,
          conversationMode: this.getConversationMode(session),
        })
      : await this.chatGateway.answer({
          query,
          history: session.history,
          prompt: session.retrieval.prompt,
        });

    return this.presentAnswer(session, answer, query);
  }

  private async presentAnswerWithoutSuggestions(
    session: PreparedSession,
    answer: string,
    query: string,
  ): Promise<PresentedAnswer> {
    const citationEvidence = session.retrieval.contexts.map((context) => ({
      documentId: context.documentId,
      chunkId: context.chunkId,
      title: context.title,
      content: context.content,
      sourceUrl: typeof context.metadata?.sourceUrl === "string" ? context.metadata.sourceUrl : undefined,
    }));
    const citationDisplayEnabled = session.retrieval.responseSettings?.citationDisplayEnabled ?? true;

    if (session.retrieval.contexts.length === 0) {
      const presented = this.answerPresentationService.present({
        answer,
        citations: citationEvidence,
        citationDisplayEnabled,
      });

      return {
        ...presented,
        suggestions: undefined,
        planningCitations: [],
        answerOutcome: ASSISTANT_TURN_OUTCOME.NO_CONTEXT_REFUSAL,
        validation: {
          ran: false,
          answerModified: false,
          unsupportedSegmentCount: 0,
          substantiveUnsupportedSegmentCount: 0,
          supportedSegmentCount: 0,
          nonSubstantiveSegmentCount: 0,
          answerSupportPolicy: this.getAnswerSupportPolicy(session),
        },
        segmentResults: [],
        conversationModeMetadata: this.getConversationModeMetadata(session),
      };
    }

    const normalized = this.answerPresentationService.normalize({
      answer,
      citations: citationEvidence,
    });

    const validated = await this.answerSupportValidator.validate({
      query,
      answer: normalized.answer,
      answerSegments: normalized.answerSegments,
      citationEvidence: normalized.citationEvidence,
      retrievedContextSummaries: citationEvidence.map((citation) => ({
        title: citation.title,
        content: citation.content,
      })),
      citationDisplayEnabled,
      answerSupportPolicy: this.getAnswerSupportPolicy(session),
      conversationMode: this.getConversationMode(session),
      groundedMissResponseComposer: this.groundedMissResponseComposer,
    });

    return {
      ...validated,
      suggestions: undefined,
      planningCitations: normalized.citationEvidence.map((citation) => ({
        documentId: citation.documentId,
        chunkId: citation.chunkId,
        title: citation.title,
      })),
      answerOutcome: this.assistantTurnOutcomeClassifier.classify({
        hadRetrievedContext: true,
        validation: validated.validation,
      }),
      conversationModeMetadata: this.getConversationModeMetadata(session),
    };
  }

  private async presentAnswer(session: PreparedSession, answer: string, query: string): Promise<PresentedAnswer> {
    const citationEvidence = session.retrieval.contexts.map((context) => ({
      documentId: context.documentId,
      chunkId: context.chunkId,
      title: context.title,
      content: context.content,
      sourceUrl: typeof context.metadata?.sourceUrl === "string" ? context.metadata.sourceUrl : undefined,
    }));
    const citationDisplayEnabled = session.retrieval.responseSettings?.citationDisplayEnabled ?? true;

    if (session.retrieval.contexts.length === 0) {
      const presented = this.answerPresentationService.present({
        answer,
        citations: citationEvidence,
        citationDisplayEnabled,
      });
      const expanded = await this.applyConversationMode(session, {
        ...presented,
        answerOutcome: ASSISTANT_TURN_OUTCOME.NO_CONTEXT_REFUSAL,
        validation: {
          ran: false,
          answerModified: false,
          unsupportedSegmentCount: 0,
          substantiveUnsupportedSegmentCount: 0,
          supportedSegmentCount: 0,
          nonSubstantiveSegmentCount: 0,
          answerSupportPolicy: this.getAnswerSupportPolicy(session),
        },
        segmentResults: [],
      });
      return expanded;
    }

    const normalized = this.answerPresentationService.normalize({
      answer,
      citations: citationEvidence,
    });

    const validated = await this.answerSupportValidator.validate({
      query,
      answer: normalized.answer,
      answerSegments: normalized.answerSegments,
      citationEvidence: normalized.citationEvidence,
      retrievedContextSummaries: citationEvidence.map((citation) => ({
        title: citation.title,
        content: citation.content,
      })),
      citationDisplayEnabled,
      answerSupportPolicy: this.getAnswerSupportPolicy(session),
      conversationMode: this.getConversationMode(session),
      groundedMissResponseComposer: this.groundedMissResponseComposer,
    });

    return await this.applyConversationMode(session, {
      ...validated,
      planningCitations: normalized.citationEvidence.map((citation) => ({
        documentId: citation.documentId,
        chunkId: citation.chunkId,
        title: citation.title,
      })),
      answerOutcome: this.assistantTurnOutcomeClassifier.classify({
        hadRetrievedContext: true,
        validation: validated.validation,
      }),
    });
  }

  private async finalizeAssistantTurn(input: {
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
    diagnostics: PreparedSession["retrieval"]["diagnostics"];
    retrievalTrace: RetrievalTrace;
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
        rewriteContinuityState: this.buildRewriteContinuityState({
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

  private async applyConversationMode(
    session: PreparedSession,
    presentation: Omit<PresentedAnswer, "conversationModeMetadata">,
  ): Promise<PresentedAnswer> {
    const conversationMode = this.getConversationMode(session);
    const brevityOverrideApplied = shouldSuppressOptionalSuggestions(session.userMessage.content);

    if (brevityOverrideApplied) {
      return {
        ...presentation,
        suggestions: undefined,
        conversationModeMetadata: this.getConversationModeMetadata(session, {
          brevityOverrideApplied: true,
          ...inferConversationModeMetadata({
            conversationMode,
            brevityOverrideApplied: true,
            suggestionCount: 0,
          }),
        }),
      };
    }

    const conversationIntentSnapshot = buildConversationIntentSnapshot({
      history: session.history,
      latestQuery: session.userMessage.content,
      priorRewriteContinuityState: session.priorRewriteContinuityState,
      rewriteProposal: session.retrieval.diagnostics.rewriteProposal,
    });
    const expanded = await this.conversationModeExpansionService.apply({
      query: session.userMessage.content,
      conversationMode,
      suggestedQuestionsEnabled: this.getSuggestedQuestionsEnabled(session),
      suggestedQuestionsCount: this.getSuggestedQuestionsCount(session),
      groundedAnswerSupported: presentation.validation.supportedSegmentCount > 0,
      answer: presentation.answer,
      citations: presentation.citations,
      contexts: session.retrieval.contexts.map((context) => ({
        documentId: context.documentId,
        chunkId: context.chunkId,
        title: context.title,
        content: context.content,
      })),
      history: session.history,
      conversationIntentSnapshot,
      suppressOptionalSuggestions: brevityOverrideApplied,
    });
    const suggestions = expanded.suggestions;

    return {
      ...presentation,
      suggestions,
      conversationModeMetadata: this.getConversationModeMetadata(session, inferConversationModeMetadata({
        conversationMode,
        brevityOverrideApplied,
        suggestionCount: suggestions?.length ?? 0,
      })),
    };
  }

  private async recordFailure(
    input: {
      workspaceId: string;
      accountId?: string;
      conversationId?: string;
      query: string;
      stream: boolean;
    },
    session: PreparedSession | null,
    existingAssistantMessageId: string | undefined,
    error: unknown,
    workflowPolicy = assertInteractiveAssistantWorkflow("chat.turn"),
  ) {
    let assistantMessageId = existingAssistantMessageId;

    if (session && assistantMessageId) {
      await this.conversationRepository.touch(session.conversation.id, input.workspaceId);
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
        conversationId: session?.conversation.id ?? input.conversationId,
        userMessageId: session?.userMessage.id,
        assistantMessageId,
        stream: input.stream,
        citationCount: 0,
        retrieval: session?.retrieval.diagnostics,
        retrievalTrace: session?.retrieval.trace
          ? this.retrievalTracePresenter.appendAnswerOutcome({
              trace: session.retrieval.trace,
              summary: this.retrievalInfoPresenter.present(session.retrieval.diagnostics),
              outcome: {
                answer: "",
                stream: input.stream,
                hadContexts: session.retrieval.contexts.length > 0,
                durationMs: 0,
              },
            })
          : undefined,
        errorMessage: error instanceof Error ? error.message : "Unknown error",
      },
    });
    try {
      await this.productAnalyticsService.track({
        eventName: "chat.failed",
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        subjectType: "conversation",
        subjectId: session?.conversation.id ?? input.conversationId,
        properties: {
          stream: input.stream,
          errorMessage: error instanceof Error ? error.message : "Unknown error",
        },
        source: "backend",
      });
    } catch {
      // Analytics fan-out must not change failure behavior.
    }
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

    return this.normalizeRewriteContinuityState(metadata?.rewriteContinuityState);
  }

  private buildRewriteContinuityState(input: {
    previousState?: RewriteContinuityState;
    diagnostics: PreparedSession["retrieval"]["diagnostics"];
    citations: ChatCitation[];
  }): RewriteContinuityState | undefined {
    const groundedTitles = this.collectContinuityValues([
      ...(input.previousState?.groundedTitles ?? []),
      ...input.citations.map((citation) => citation.title),
    ]);
    const activeSubject = this.resolveContinuityActiveSubject(
      this.normalizeContinuityValue(input.diagnostics.rewriteProposal?.proposedActiveSubject)
        ?? input.previousState?.activeSubject,
      groundedTitles,
    );
    const relatedEntities: string[] = [];

    if (!activeSubject && relatedEntities.length === 0 && groundedTitles.length === 0) {
      return undefined;
    }

    return {
      activeSubject,
      relatedEntities,
      groundedTitles,
    };
  }

  private normalizeRewriteContinuityState(state: unknown): RewriteContinuityState | undefined {
    if (!state || typeof state !== "object") {
      return undefined;
    }

    const candidate = state as Partial<Record<keyof RewriteContinuityState, unknown>>;
    const groundedTitles = this.collectContinuityValues(
      Array.isArray(candidate.groundedTitles)
        ? candidate.groundedTitles.map((value) => (typeof value === "string" ? value : undefined))
        : [],
    );
    const activeSubject = this.resolveContinuityActiveSubject(
      typeof candidate.activeSubject === "string" ? candidate.activeSubject : undefined,
      groundedTitles,
    );
    const relatedEntities: string[] = [];

    if (!activeSubject && relatedEntities.length === 0 && groundedTitles.length === 0) {
      return undefined;
    }

    return {
      activeSubject,
      relatedEntities,
      groundedTitles,
    };
  }

  private resolveContinuityActiveSubject(candidate: string | undefined, groundedTitles: string[]): string | undefined {
    const normalizedCandidate = this.normalizeContinuityValue(candidate);
    if (normalizedCandidate) {
      return normalizedCandidate;
    }

    return groundedTitles.length === 1 ? groundedTitles[0] : undefined;
  }

  private collectContinuityValues(values: Array<string | undefined>): string[] {
    const unique: string[] = [];
    for (const value of values) {
      const normalized = this.normalizeContinuityValue(value);
      if (!normalized || unique.includes(normalized)) {
        continue;
      }
      unique.push(normalized);
      if (unique.length >= CHAT_BEHAVIOR.carryForward.maxLiterals) {
        break;
      }
    }
    return unique;
  }

  private normalizeContinuityValue(value?: string): string | undefined {
    if (typeof value !== "string") {
      return undefined;
    }

    const normalized = value.trim();
    if (normalized.length === 0 || normalized.length > CHAT_BEHAVIOR.carryForward.maxLiteralLength) {
      return undefined;
    }

    try {
      const url = new URL(normalized);
      if (url.protocol) {
        return undefined;
      }
    } catch {
      // Keep non-URL values.
    }

    return normalized;
  }
}

const ASSISTANT_IDENTITY_EXPLICIT_PATTERNS = [
  /\bwhat(?:'s| is) your name\b/i,
  /\bwho are you\b/i,
  /\byour role\b/i,
  /\bcome ti chiami\b/i,
  /\bchi sei\b/i,
  /\bqual(?: è|e') il tuo nome\b/i,
];

const ASSISTANT_IDENTITY_STANDALONE_PATTERNS = [
  /^\s*what do you do[?.!\s]*$/i,
  /^\s*what can you do[?.!\s]*$/i,
  /^\s*cosa fai[?.!\s]*$/i,
];

const isAssistantIdentityQuestion = (query: string): boolean =>
  ASSISTANT_IDENTITY_EXPLICIT_PATTERNS.some((pattern) => pattern.test(query))
  || ASSISTANT_IDENTITY_STANDALONE_PATTERNS.some((pattern) => pattern.test(query));

const buildAssistantIdentityAnswerPrompt = (input: {
  assistantIdentity: AssistantIdentityPromptInput;
  history: MessageRecord[];
  query: string;
}): string => {
  const historySection = input.history
    .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
    .join("\n");
  const identityLines = [
    input.assistantIdentity.assistantName ? `Assistant name: ${input.assistantIdentity.assistantName}` : null,
    input.assistantIdentity.assistantRole ? `Assistant role: ${input.assistantIdentity.assistantRole}` : null,
    input.assistantIdentity.greetingInstruction ? `Assistant style: ${input.assistantIdentity.greetingInstruction}` : null,
  ].filter((line): line is string => line !== null);

  return renderPromptTemplate("chat/assistant-identity-answer.md", {
    identity_lines: identityLines.join("\n"),
    history_section: historySection || "No prior history",
    query: input.query,
  });
};
