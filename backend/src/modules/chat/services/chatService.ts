import type OpenAI from "openai";

import { notFound } from "../../../shared/domain/errors.js";
import type { AuditService } from "../../audit/services/auditService.js";
import type { ConversationRecord, ConversationRepositoryPort } from "../../../db/repositories/conversationRepository.js";
import type { MessageRecord, MessageRepositoryPort } from "../../../db/repositories/messageRepository.js";
import { RetrievalInfoPresenter, type RetrievalInfo } from "../../retrieval/services/retrievalInfoPresenter.js";
import type { RetrievalPipelineService } from "../../retrieval/services/retrievalPipelineService.js";
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
    };

interface PreparedSession {
  conversation: ConversationRecord;
  history: MessageRecord[];
  retrieval: Awaited<ReturnType<RetrievalPipelineService["run"]>>;
  userMessage: MessageRecord;
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

  constructor(
    private readonly conversationRepository: ConversationRepositoryPort,
    private readonly messageRepository: MessageRepositoryPort,
    private readonly retrievalPipeline: RetrievalPipelineService,
    private readonly chatGateway: ChatGateway,
    private readonly auditService: AuditService,
  ) {}

  async answer(input: {
    accountId: string;
    conversationId?: string;
    query: string;
    stream: boolean;
  }): Promise<{
    conversationId: string;
    answer: string;
    citations?: ChatCitation[];
    answerSegments?: AnswerSegment[];
    retrievalInfo: RetrievalInfo;
  }> {
    let session: PreparedSession | null = null;
    let assistantMessageId: string | undefined;

    try {
      session = await this.prepareSession(input);
      const presentation = await this.generateAnswerPresentation(session, input.query);

      const assistantMessage = await this.messageRepository.create({
        conversationId: session.conversation.id,
        accountId: input.accountId,
        role: "assistant",
        content: presentation.answer,
      });
      assistantMessageId = assistantMessage.id;
      await this.finalizeAssistantTurn({
        accountId: input.accountId,
        conversationId: session.conversation.id,
        userMessageId: session.userMessage.id,
        assistantMessageId,
        citations: presentation.citations ?? [],
        diagnostics: session.retrieval.diagnostics,
        stream: input.stream,
      });

      return {
        conversationId: session.conversation.id,
        answer: presentation.answer,
        citations: presentation.citations,
        answerSegments: presentation.answerSegments,
        retrievalInfo: this.retrievalInfoPresenter.present(session.retrieval.diagnostics),
      };
    } catch (error) {
      await this.recordFailure(input, session, assistantMessageId, error);
      throw error;
    }
  }

  async *streamAnswer(input: {
    accountId: string;
    conversationId?: string;
    query: string;
    stream: boolean;
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

      if (session.retrieval.contexts.length === 0) {
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
        accountId: input.accountId,
        role: "assistant",
        content: presentation.answer,
      });
      assistantMessageId = assistantMessage.id;
      await this.finalizeAssistantTurn({
        accountId: input.accountId,
        conversationId: session.conversation.id,
        userMessageId: session.userMessage.id,
        assistantMessageId,
        citations: presentation.citations ?? [],
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
      };
    } catch (error) {
      await this.recordFailure(input, session, assistantMessageId, error);
      throw error;
    }
  }

  private async prepareSession(input: {
    accountId: string;
    conversationId?: string;
    query: string;
  }): Promise<PreparedSession> {
    const conversation = input.conversationId
      ? await this.ensureConversation(input.conversationId, input.accountId)
      : null;
    const history = conversation
      ? await this.messageRepository.listByConversationId(conversation.id)
      : [];
    const retrieval = await this.retrievalPipeline.run({
      accountId: input.accountId,
      query: input.query,
      history,
    });
    const persistedConversation = conversation ?? await this.conversationRepository.create(input.accountId);

    const userMessage = await this.messageRepository.create({
      conversationId: persistedConversation.id,
      accountId: input.accountId,
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
    const answer =
      session.retrieval.contexts.length === 0
        ? "I could not find relevant information in your documents."
        : await this.chatGateway.answer({
            query,
            history: session.history,
            prompt: session.retrieval.prompt,
          });

    return this.presentAnswer(session, answer);
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
    accountId: string;
    conversationId: string;
    userMessageId: string;
    assistantMessageId: string;
    citations: ChatCitation[];
    diagnostics: PreparedSession["retrieval"]["diagnostics"];
    stream: boolean;
  }): Promise<void> {
    await this.conversationRepository.touch(input.conversationId);
    await this.auditService.record({
      accountId: input.accountId,
      eventType: "chat.answer",
      eventStatus: "success",
      metadata: {
        conversationId: input.conversationId,
        userMessageId: input.userMessageId,
        assistantMessageId: input.assistantMessageId,
        stream: input.stream,
        citationCount: input.citations.length,
        retrieval: input.diagnostics,
      },
    });
  }

  private async recordFailure(
    input: {
      accountId: string;
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
        accountId: input.accountId,
        role: "assistant",
        content: "Sorry, something went wrong. Please try again.",
      });
      assistantMessageId = assistantMessage.id;
      await this.conversationRepository.touch(session.conversation.id);
    }

    await this.auditService.record({
      accountId: input.accountId,
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

  private async ensureConversation(conversationId: string, accountId: string) {
    const conversation = await this.conversationRepository.findByIdAndAccountId(conversationId, accountId);

    if (!conversation) {
      throw notFound("Conversation not found");
    }

    return conversation;
  }
}
