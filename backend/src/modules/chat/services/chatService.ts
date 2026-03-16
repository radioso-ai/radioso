import type OpenAI from "openai";

import { notFound } from "../../../shared/domain/errors.js";
import type { RetrievalExecutionDiagnostics } from "../../retrieval/domain/retrievalPipelineTypes.js";
import type { AuditService } from "../../audit/services/auditService.js";
import type { ConversationRepositoryPort } from "../../../db/repositories/conversationRepository.js";
import type { MessageRecord, MessageRepositoryPort } from "../../../db/repositories/messageRepository.js";
import { RetrievalInfoPresenter, type RetrievalInfo } from "../../retrieval/services/retrievalInfoPresenter.js";
import type { RetrievalPipelineService } from "../../retrieval/services/retrievalPipelineService.js";
import {
  AnswerPresentationService,
  type AnswerSegment,
  type ChatCitation,
} from "./answerPresentationService.js";
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
  private readonly unsafeEntityBlendMessage =
    "I found conflicting information that seems to refer to different subjects. Please clarify which one you mean.";

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
    try {
      const session = await this.prepareSession(input);
      const answer =
        session.retrieval.contexts.length === 0
          ? "I could not find relevant information in your documents."
          : this.shouldBlockForEntityAmbiguity(session.retrieval)
            ? this.unsafeEntityBlendMessage
          : await this.chatGateway.answer({
              query: input.query,
              history: session.history,
              prompt: session.retrieval.prompt,
            });

      const presentation = this.answerPresentationService.present({
        answer,
        citations: session.retrieval.contexts.map((context) => ({
          documentId: context.documentId,
          chunkId: context.chunkId,
          title: context.title,
          content: context.content,
        })),
        citationDisplayEnabled: session.retrieval.responseSettings?.citationDisplayEnabled ?? true,
      });

      await this.completeAnswer({
        accountId: input.accountId,
        conversationId: session.conversation.id,
        answer: presentation.answer,
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
      await this.auditService.record({
        accountId: input.accountId,
        eventType: "chat.answer",
        eventStatus: "failure",
        metadata: { stream: input.stream, stage: "chat.answer" },
      });
      throw error;
    }
  }

  async *streamAnswer(input: {
    accountId: string;
    conversationId?: string;
    query: string;
    stream: boolean;
  }): AsyncIterable<ChatStreamEvent> {
    try {
      const session = await this.prepareSession(input);

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
      } else if (this.shouldBlockForEntityAmbiguity(session.retrieval)) {
        rawAnswer = this.unsafeEntityBlendMessage;
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

      const presentation = this.answerPresentationService.present({
        answer: rawAnswer,
        citations: session.retrieval.contexts.map((context) => ({
          documentId: context.documentId,
          chunkId: context.chunkId,
          title: context.title,
          content: context.content,
        })),
        citationDisplayEnabled: session.retrieval.responseSettings?.citationDisplayEnabled ?? true,
      });

      await this.completeAnswer({
        accountId: input.accountId,
        conversationId: session.conversation.id,
        answer: presentation.answer,
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
      await this.auditService.record({
        accountId: input.accountId,
        eventType: "chat.answer",
        eventStatus: "failure",
        metadata: { stream: input.stream, stage: "chat.answer" },
      });
      throw error;
    }
  }

  private async prepareSession(input: {
    accountId: string;
    conversationId?: string;
    query: string;
  }) {
    const conversation = input.conversationId
      ? await this.ensureConversation(input.conversationId, input.accountId)
      : await this.conversationRepository.create(input.accountId);
    const history = await this.messageRepository.listByConversationId(conversation.id);
    const retrieval = await this.retrievalPipeline.run({
      accountId: input.accountId,
      query: input.query,
      history,
    });

    await this.messageRepository.create({
      conversationId: conversation.id,
      accountId: input.accountId,
      role: "user",
      content: input.query,
    });

    return {
      conversation,
      history,
      retrieval,
    };
  }

  private async completeAnswer(input: {
    accountId: string;
    conversationId: string;
    answer: string;
    citations: ChatCitation[];
    diagnostics: RetrievalExecutionDiagnostics;
    stream: boolean;
  }) {
    await this.messageRepository.create({
      conversationId: input.conversationId,
      accountId: input.accountId,
      role: "assistant",
      content: input.answer,
    });
    await this.conversationRepository.touch(input.conversationId);
    await this.auditService.record({
      accountId: input.accountId,
      eventType: "chat.answer",
      eventStatus: "success",
      metadata: {
        conversationId: input.conversationId,
        stream: input.stream,
        citationCount: input.citations.length,
        retrieval: input.diagnostics,
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

  private shouldBlockForEntityAmbiguity(
    retrieval: Awaited<ReturnType<RetrievalPipelineService["run"]>>,
  ): boolean {
    if (!retrieval.entityIntegrity) {
      return false;
    }

    return (
      retrieval.entityIntegrity.ambiguityDetected &&
      retrieval.entityIntegrity.selectedSubjects.length === 0
    );
  }
}
