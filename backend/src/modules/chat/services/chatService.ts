import { notFound } from "../../../shared/domain/errors.js";
import { normalizeProviderCredentialError } from "../../../shared/infra/llm/providerErrors.js";
import type { TextGenerationClient } from "../../../shared/infra/llm/providerTypes.js";
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
  DefaultUnsupportedNoticeGenerator,
  type UnsupportedNoticeGenerator,
} from "./unsupportedNoticeGenerator.js";
import type { AnswerSupportPolicy } from "../../settings/domain/retrievalSettings.js";
import { DEFAULT_ANSWER_SUPPORT_POLICY } from "../../settings/domain/retrievalSettings.js";
import type { RetrievalTrace } from "../../retrieval/domain/retrievalPipelineTypes.js";
import { shouldReplaceUnsupportedSegments } from "./answerSupportPolicy.js";
import type { ChatResponse } from "../types/chatResponses.js";

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

export type ChatStreamEvent =
  | { type: "conversation"; conversationId: string }
  | { type: "chunk"; text: string }
  | {
      type: "done";
      conversationId: string;
      answer: string;
      citations?: ChatCitation[];
      answerSegments?: AnswerSegment[];
      retrievalInfo: RetrievalInfo;
      retrievalTrace: RetrievalTrace;
    };

interface PreparedSession {
  conversation: ConversationRecord;
  history: MessageRecord[];
  retrieval: Awaited<ReturnType<RetrievalPipelineService["run"]>>;
  userMessage: MessageRecord;
}

interface ChatAnswerAuditMetadata {
  answerOutcome?: AssistantTurnOutcome;
  answerSupportPolicy?: AnswerSupportPolicy;
  validation?: AnswerValidationSummary & {
    segmentResults?: Array<Pick<AnswerSegmentValidationResult, "text" | "disposition" | "replacementApplied" | "reason" | "citationIndices">>;
  };
  carryForwardLiterals?: string[];
  citations?: ChatCitation[];
  answerSegments?: AnswerSegment[];
  retrievalTrace?: RetrievalTrace;
}

interface PresentedAnswer {
  answer: string;
  citations?: ChatCitation[];
  answerSegments?: AnswerSegment[];
  answerOutcome: AssistantTurnOutcome;
  validation: AnswerValidationSummary;
  segmentResults: AnswerSegmentValidationResult[];
}

export class ModelChatGateway implements ChatGateway {
  constructor(private readonly client: TextGenerationClient) {}

  async answer(input: { query: string; history: MessageRecord[]; prompt: string }): Promise<string> {
    const response = await this.client.complete({
      prompt: input.prompt,
    });

    return response || "I could not generate an answer.";
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
  private static readonly MAX_CARRY_FORWARD_LITERALS = 6;
  private static readonly MAX_CARRY_FORWARD_LITERAL_LENGTH = 120;

  constructor(
    private readonly conversationRepository: ConversationRepositoryPort,
    private readonly messageRepository: MessageRepositoryPort,
    private readonly retrievalPipeline: RetrievalPipelineService,
    private readonly chatGateway: ChatGateway,
    private readonly auditService: AuditService,
    private readonly unsupportedNoticeGenerator: UnsupportedNoticeGenerator = new DefaultUnsupportedNoticeGenerator(),
  ) {}

  private getAnswerSupportPolicy(session: PreparedSession): AnswerSupportPolicy {
    return session.retrieval.responseSettings?.answerSupportPolicy ?? DEFAULT_ANSWER_SUPPORT_POLICY;
  }

  async answer(input: {
    workspaceId: string;
    accountId?: string;
    conversationId?: string;
    query: string;
    stream: boolean;
    metadataFilter?: Record<string, unknown>;
    sourceChannel?: string | null;
    anonymousSessionId?: string | null;
  }): Promise<ChatResponse> {
    let session: PreparedSession | null = null;
    let assistantMessageId: string | undefined;

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
        answerSupportPolicy: presentation.validation.answerSupportPolicy,
        diagnostics: session.retrieval.diagnostics,
        retrievalTrace,
        stream: input.stream,
      });

      return {
        conversationId: session.conversation.id,
        answer: presentation.answer,
        citations: presentation.citations,
        answerSegments: presentation.answerSegments,
        retrievalInfo,
        retrievalTrace,
      };
    } catch (error) {
      const normalizedError = normalizeProviderCredentialError(error);
      await this.recordFailure(input, session, assistantMessageId, normalizedError);
      throw normalizedError;
    }
  }

  async *streamAnswer(input: {
    workspaceId: string;
    accountId?: string;
    conversationId?: string;
    query: string;
    stream: boolean;
    metadataFilter?: Record<string, unknown>;
    sourceChannel?: string | null;
    anonymousSessionId?: string | null;
  }): AsyncIterable<ChatStreamEvent> {
    let session: PreparedSession | null = null;
    let assistantMessageId: string | undefined;

    try {
      session = await this.prepareSession(input);

      yield {
        type: "conversation",
        conversationId: session.conversation.id,
      };

      let rawAnswer = "";
      const answerStartedAt = Date.now();
      const answerSupportPolicy = this.getAnswerSupportPolicy(session);
      const suppressRawStreaming =
        session.retrieval.contexts.length > 0 && shouldReplaceUnsupportedSegments(answerSupportPolicy);

      if (session.retrieval.contexts.length === 0) {
        rawAnswer = "I could not find relevant information in your documents.";
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
      }

      const presentation = await this.presentAnswer(session, rawAnswer, input.query);

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
        answerSupportPolicy: presentation.validation.answerSupportPolicy,
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
        retrievalInfo,
        retrievalTrace,
      };
    } catch (error) {
      const normalizedError = normalizeProviderCredentialError(error);
      await this.recordFailure(input, session, assistantMessageId, normalizedError);
      throw normalizedError;
    }
  }

  private async prepareSession(input: {
    workspaceId: string;
    accountId?: string;
    conversationId?: string;
    query: string;
    metadataFilter?: Record<string, unknown>;
    sourceChannel?: string | null;
    anonymousSessionId?: string | null;
  }): Promise<PreparedSession> {
    const conversation = input.conversationId
      ? await this.ensureConversation(input.conversationId, input.workspaceId, input.anonymousSessionId)
      : null;
    const history = conversation
      ? await this.messageRepository.listByConversationId(input.workspaceId, conversation.id)
      : [];
    const carryForwardLiterals = conversation
      ? await this.loadRewriteCarryForwardLiterals(input.workspaceId, conversation.id)
      : undefined;
    const retrieval = await this.retrievalPipeline.run({
      workspaceId: input.workspaceId,
      query: input.query,
      history,
      rewriteCarryForwardLiterals: carryForwardLiterals,
      metadataFilter: input.metadataFilter,
    });
    const persistedConversation =
      conversation ?? await this.conversationRepository.create(input.workspaceId, input.sourceChannel ?? null, input.anonymousSessionId ?? null);

    const userMessage = await this.messageRepository.create({
      conversationId: persistedConversation.id,
      workspaceId: input.workspaceId,
      role: "user",
      content: input.query,
    });

    return {
      conversation: persistedConversation,
      history,
      retrieval,
      userMessage,
    };
  }

  private async generateAnswerPresentation(
    session: PreparedSession,
    query: string,
  ): Promise<PresentedAnswer> {
    const answer = session.retrieval.contexts.length === 0
      ? "I could not find relevant information in your documents."
      : await this.chatGateway.answer({
          query,
          history: session.history,
          prompt: session.retrieval.prompt,
        });

    return this.presentAnswer(session, answer, query);
  }

  private async presentAnswer(session: PreparedSession, answer: string, query: string): Promise<PresentedAnswer> {
    const citationEvidence = session.retrieval.contexts.map((context) => ({
      documentId: context.documentId,
      chunkId: context.chunkId,
      title: context.title,
      content: context.content,
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
        answerOutcome: ASSISTANT_TURN_OUTCOME.NO_CONTEXT_REFUSAL,
        validation: {
          ran: false,
          answerModified: false,
          unsupportedSegmentCount: 0,
          supportedSegmentCount: 0,
          nonSubstantiveSegmentCount: 0,
          answerSupportPolicy: this.getAnswerSupportPolicy(session),
        },
        segmentResults: [],
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
      citationDisplayEnabled,
      answerSupportPolicy: this.getAnswerSupportPolicy(session),
      unsupportedNoticeGenerator: this.unsupportedNoticeGenerator,
    });

    return {
      ...validated,
      answerOutcome: this.assistantTurnOutcomeClassifier.classify({
        hadRetrievedContext: true,
        validation: validated.validation,
      }),
    };
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
    answerSupportPolicy?: AnswerSupportPolicy;
    diagnostics: PreparedSession["retrieval"]["diagnostics"];
    retrievalTrace: RetrievalTrace;
    stream: boolean;
  }): Promise<void> {
    await this.conversationRepository.touch(input.conversationId, input.workspaceId);
    await this.auditService.record({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      eventType: "chat.answer",
      eventStatus: "success",
      metadata: {
        conversationId: input.conversationId,
        userMessageId: input.userMessageId,
        assistantMessageId: input.assistantMessageId,
        stream: input.stream,
        answerOutcome: input.answerOutcome,
        answerSupportPolicy: input.answerSupportPolicy,
        validation: {
          ...input.validation,
          segmentResults: input.segmentResults.map((segment) => ({
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
        carryForwardLiterals: this.buildCarryForwardLiterals({
          diagnostics: input.diagnostics,
        }),
        retrieval: input.diagnostics,
        retrievalTrace: input.retrievalTrace,
      },
    });
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
  ) {
    let assistantMessageId = existingAssistantMessageId;

    if (session && !assistantMessageId) {
      const assistantMessage = await this.messageRepository.create({
        conversationId: session.conversation.id,
        workspaceId: input.workspaceId,
        role: "assistant",
        content: "Sorry, something went wrong. Please try again.",
      });
      assistantMessageId = assistantMessage.id;
      await this.conversationRepository.touch(session.conversation.id, input.workspaceId);
    }

    await this.auditService.record({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      eventType: "chat.answer",
      eventStatus: "failure",
      metadata: {
        stage: "chat.answer",
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
                answer: "Sorry, something went wrong. Please try again.",
                stream: input.stream,
                hadContexts: session.retrieval.contexts.length > 0,
                durationMs: 0,
              },
            })
          : undefined,
        errorMessage: error instanceof Error ? error.message : "Unknown error",
      },
    });
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

  private async loadRewriteCarryForwardLiterals(
    workspaceId: string,
    conversationId: string,
  ): Promise<string[] | undefined> {
    const metadata = await this.auditService.getLatestSuccessfulChatAnswerMetadata({
      workspaceId,
      conversationId,
    }) as ChatAnswerAuditMetadata | null;

    const literals = metadata?.carryForwardLiterals?.filter((value): value is string => typeof value === "string");
    return literals && literals.length > 0 ? literals : undefined;
  }

  private buildCarryForwardLiterals(input: {
    diagnostics: PreparedSession["retrieval"]["diagnostics"];
  }): string[] {
    const candidates = [input.diagnostics.rewriteProposal?.proposedActiveSubject];

    const unique: string[] = [];
    for (const value of candidates) {
      if (typeof value !== "string") {
        continue;
      }

      const literal = value.trim();
      if (literal.length === 0 || literal.length > ChatService.MAX_CARRY_FORWARD_LITERAL_LENGTH) {
        continue;
      }

      if (this.isUrlLikeLiteral(literal)) {
        continue;
      }

      if (unique.includes(literal)) {
        continue;
      }

      unique.push(literal);
      if (unique.length >= ChatService.MAX_CARRY_FORWARD_LITERALS) {
        break;
      }
    }

    return unique;
  }

  private isUrlLikeLiteral(value: string): boolean {
    return /^https?:\/\//i.test(value) || /^www\./i.test(value);
  }
}
