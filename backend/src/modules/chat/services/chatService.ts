import type OpenAI from "openai";

import { notFound } from "../../../shared/domain/errors.js";
import type { AuditService } from "../../audit/services/auditService.js";
import type { ConversationRepositoryPort } from "../../../db/repositories/conversationRepository.js";
import type { MessageRecord, MessageRepositoryPort } from "../../../db/repositories/messageRepository.js";
import type { RetrievalPipelineService } from "../../retrieval/services/retrievalPipelineService.js";

export interface ChatGateway {
  answer(input: {
    query: string;
    history: MessageRecord[];
    prompt: string;
  }): Promise<string>;
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
}

export class ChatService {
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
    citations: Array<{ documentId: string; chunkId: string; title: string }>;
  }> {
    try {
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

      const answer =
        retrieval.contexts.length === 0
          ? "I could not find relevant information in your documents."
          : await this.chatGateway.answer({
              query: input.query,
              history,
              prompt: retrieval.prompt,
            });

      await this.messageRepository.create({
        conversationId: conversation.id,
        accountId: input.accountId,
        role: "assistant",
        content: answer,
      });
      await this.conversationRepository.touch(conversation.id);
      await this.auditService.record({
        accountId: input.accountId,
        eventType: "chat.answer",
        eventStatus: "success",
        metadata: {
          conversationId: conversation.id,
          stream: input.stream,
          citationCount: retrieval.citations.length,
        },
      });

      return {
        conversationId: conversation.id,
        answer,
        citations: retrieval.citations,
      };
    } catch (error) {
      await this.auditService.record({
        accountId: input.accountId,
        eventType: "chat.answer",
        eventStatus: "failure",
        metadata: { stream: input.stream },
      });
      throw error;
    }
  }

  private async ensureConversation(conversationId: string, accountId: string) {
    const conversation = await this.conversationRepository.findByIdAndAccountId(conversationId, accountId);

    if (!conversation) {
      throw notFound("Conversation not found");
    }

    return conversation;
  }
}
