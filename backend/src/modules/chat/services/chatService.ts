import type OpenAI from "openai";

import { notFound } from "../../../shared/domain/errors.js";
import type { AuditService } from "../../audit/services/auditService.js";
import type { ConversationRecord, ConversationRepositoryPort } from "../../../db/repositories/conversationRepository.js";
import type { MessageRecord, MessageRepositoryPort } from "../../../db/repositories/messageRepository.js";
import { RetrievalInfoPresenter, type RetrievalInfo } from "../../retrieval/services/retrievalInfoPresenter.js";
import type { RetrievalPipelineService } from "../../retrieval/services/retrievalPipelineService.js";
import { PromptBuilder } from "../../retrieval/services/promptBuilder.js";
import { AnswerPresentationService, type AnswerSegment, type ChatCitation } from "./answerPresentationService.js";
import { CitationAnchorSanitizer } from "./citationAnchorSanitizer.js";

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
      source?: "retrieval" | "inference";
    };

interface PreparedSession {
  conversation: ConversationRecord;
  history: MessageRecord[];
  retrieval: Awaited<ReturnType<RetrievalPipelineService["run"]>>;
  userMessage: MessageRecord;
}

interface ChatAnswerAuditMetadata {
  carryForwardLiterals?: string[];
  citations?: ChatCitation[];
  answerSegments?: AnswerSegment[];
}

interface PresentedAnswer {
  answer: string;
  citations?: ChatCitation[];
  answerSegments?: AnswerSegment[];
}

export class OpenAIChatGateway implements ChatGateway {
  constructor(
    private readonly client: OpenAI,
    private readonly model: string,
  ) {}

  async answer(input: { query: string; history: MessageRecord[]; prompt: string }): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        {
          role: "user",
          content: input.prompt,
        },
      ],
    });

    return response.choices[0]?.message?.content ?? "I could not generate an answer.";
  }

  async *streamAnswer(input: { query: string; history: MessageRecord[]; prompt: string }): AsyncIterable<string> {
    const stream = await this.client.chat.completions.create({
      model: this.model,
      stream: true,
      messages: [
        {
          role: "user",
          content: input.prompt,
        },
      ],
    });

    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content ?? "";
      if (text.length > 0) {
        yield text;
      }
    }
  }
}

export class ChatService {
  private readonly answerPresentationService = new AnswerPresentationService();
  private readonly retrievalInfoPresenter = new RetrievalInfoPresenter();
  private static readonly MAX_CARRY_FORWARD_LITERALS = 6;
  private static readonly MAX_CARRY_FORWARD_LITERAL_LENGTH = 120;

  constructor(
    private readonly conversationRepository: ConversationRepositoryPort,
    private readonly messageRepository: MessageRepositoryPort,
    private readonly retrievalPipeline: RetrievalPipelineService,
    private readonly chatGateway: ChatGateway,
    private readonly auditService: AuditService,
    private readonly promptBuilder: PromptBuilder = new PromptBuilder(),
  ) {}

  async answer(input: {
    workspaceId: string;
    accountId?: string;
    conversationId?: string;
    query: string;
    stream: boolean;
    metadataFilter?: Record<string, unknown>;
    sourceChannel?: string | null;
    anonymousSessionId?: string | null;
  }): Promise<{
    conversationId: string;
    answer: string;
    citations?: ChatCitation[];
    answerSegments?: AnswerSegment[];
    retrievalInfo: RetrievalInfo;
    source?: "retrieval" | "inference";
  }> {
    let session: PreparedSession | null = null;
    let assistantMessageId: string | undefined;

    try {
      session = await this.prepareSession(input);
      const presentation = await this.generateAnswerPresentation(session, input.query);

      if (presentation.inferenceError) {
        await this.auditService.record({
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          eventType: "chat.answer",
          eventStatus: "failure",
          metadata: {
            stage: "inference_fallback",
            conversationId: session.conversation.id,
            userMessageId: session.userMessage.id,
            stream: input.stream,
            errorMessage: presentation.inferenceError instanceof Error ? presentation.inferenceError.message : "Unknown inference error",
          },
        });
      }

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
        citations: presentation.citations ?? [],
        answerSegments: presentation.answerSegments,
        diagnostics: session.retrieval.diagnostics,
        stream: input.stream,
      });

      return {
        conversationId: session.conversation.id,
        answer: presentation.answer,
        citations: presentation.citations,
        answerSegments: presentation.answerSegments,
        retrievalInfo: this.retrievalInfoPresenter.present(session.retrieval.diagnostics),
        source: presentation.source,
      };
    } catch (error) {
      await this.recordFailure(input, session, assistantMessageId, error);
      throw error;
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
      const sanitizer = new CitationAnchorSanitizer();
      let answerSource: "retrieval" | "inference" = "retrieval";

      if (session.retrieval.contexts.length === 0 && (session.retrieval.responseSettings?.inferenceAnswerEnabled ?? false)) {
        answerSource = "inference";
        try {
          const inferencePrompt = this.promptBuilder.buildInferencePrompt({
            query: input.query,
            history: session.history,
            settings: {
              warmthLevel: session.retrieval.responseSettings?.warmthLevel ?? 5,
              customInstruction: session.retrieval.responseSettings?.customInstruction,
            },
          });
          for await (const text of this.chatGateway.streamAnswer({
            query: input.query,
            history: session.history,
            prompt: inferencePrompt,
          })) {
            if (!text) continue;
            rawAnswer = `${rawAnswer}${text}`;
            yield { type: "chunk", text };
          }
        } catch (inferenceError) {
          answerSource = "retrieval";
          rawAnswer = "I could not find relevant information in your documents.";
          yield { type: "chunk", text: rawAnswer };
          await this.auditService.record({
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            eventType: "chat.answer",
            eventStatus: "failure",
            metadata: {
              stage: "inference_fallback",
              conversationId: session.conversation.id,
              userMessageId: session.userMessage.id,
              stream: input.stream,
              errorMessage: inferenceError instanceof Error ? inferenceError.message : "Unknown inference error",
            },
          });
        }
      } else if (session.retrieval.contexts.length === 0) {
        rawAnswer = "I could not find relevant information in your documents.";
        yield {
          type: "chunk",
          text: rawAnswer,
        };
      } else {
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
          if (!safe) {
            continue;
          }
          yield {
            type: "chunk",
            text: safe,
          };
        }
      }

      const presentation = this.presentAnswer(session, rawAnswer);

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
        citations: presentation.citations ?? [],
        answerSegments: presentation.answerSegments,
        diagnostics: session.retrieval.diagnostics,
        stream: input.stream,
      });

      yield {
        type: "done",
        conversationId: session.conversation.id,
        answer: presentation.answer,
        citations: presentation.citations,
        answerSegments: presentation.answerSegments,
        retrievalInfo: this.retrievalInfoPresenter.present(session.retrieval.diagnostics),
        source: answerSource,
      };
    } catch (error) {
      await this.recordFailure(input, session, assistantMessageId, error);
      throw error;
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
      ? await this.messageRepository.listByConversationId(conversation.id)
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
  ): Promise<PresentedAnswer & { source: "retrieval" | "inference"; inferenceError?: unknown }> {
    if (session.retrieval.contexts.length === 0) {
      const inferenceEnabled = session.retrieval.responseSettings?.inferenceAnswerEnabled ?? false;

      if (inferenceEnabled) {
        try {
          const inferencePrompt = this.promptBuilder.buildInferencePrompt({
            query,
            history: session.history,
            settings: {
              warmthLevel: session.retrieval.responseSettings?.warmthLevel ?? 5,
              customInstruction: session.retrieval.responseSettings?.customInstruction,
            },
          });
          const answer = await this.chatGateway.answer({
            query,
            history: session.history,
            prompt: inferencePrompt,
          });
          return { answer, source: "inference" };
        } catch (inferenceError) {
          return {
            answer: "I could not find relevant information in your documents.",
            source: "retrieval",
            inferenceError,
          };
        }
      }

      return {
        answer: "I could not find relevant information in your documents.",
        source: "retrieval",
      };
    }

    const answer = await this.chatGateway.answer({
      query,
      history: session.history,
      prompt: session.retrieval.prompt,
    });

    return { ...this.presentAnswer(session, answer), source: "retrieval" };
  }

  private presentAnswer(session: PreparedSession, answer: string): PresentedAnswer {
    return this.answerPresentationService.present({
      answer,
      citations: session.retrieval.contexts.map((context) => ({
        documentId: context.documentId,
        chunkId: context.chunkId,
        title: context.title,
        content: context.content,
      })),
      citationDisplayEnabled: session.retrieval.responseSettings?.citationDisplayEnabled ?? true,
    });
  }

  private async finalizeAssistantTurn(input: {
    workspaceId: string;
    accountId?: string;
    conversationId: string;
    userMessageId: string;
    assistantMessageId: string;
    citations: ChatCitation[];
    answerSegments?: AnswerSegment[];
    diagnostics: PreparedSession["retrieval"]["diagnostics"];
    stream: boolean;
  }): Promise<void> {
    await this.conversationRepository.touch(input.conversationId);
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
        citationCount: input.citations.length,
        citations: input.citations,
        answerSegments: input.answerSegments,
        carryForwardLiterals: this.buildCarryForwardLiterals({
          diagnostics: input.diagnostics,
          citations: input.citations,
        }),
        retrieval: input.diagnostics,
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
      await this.conversationRepository.touch(session.conversation.id);
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
        errorMessage: error instanceof Error ? error.message : "Unknown error",
      },
    });
  }

  private async ensureConversation(conversationId: string, workspaceId: string, anonymousSessionId?: string | null) {
    // When an anonymous session is provided, verify the conversation belongs to that session
    if (anonymousSessionId) {
      const conversation = await this.conversationRepository.findByIdAndAnonymousSession(conversationId, anonymousSessionId);
      if (!conversation || conversation.workspaceId !== workspaceId) {
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
    citations: ChatCitation[];
  }): string[] {
    const candidates = [
      input.diagnostics.rewriteProposal?.proposedActiveSubject,
      ...(input.diagnostics.rewriteProposal?.relatedEntities ?? []),
      ...input.citations.map((citation) => citation.title),
    ];

    const unique: string[] = [];
    for (const value of candidates) {
      if (typeof value !== "string") {
        continue;
      }

      const literal = value.trim();
      if (literal.length === 0 || literal.length > ChatService.MAX_CARRY_FORWARD_LITERAL_LENGTH) {
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
}
