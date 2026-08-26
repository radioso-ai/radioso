import { notFound } from "../../shared/domain/errors.js";
import type { WorkspaceInvalidationPublisher } from "@radioso/workspace-invalidation-contract";
import type { ConversationRepositoryPort } from "../../db/repositories/conversationRepository.js";
import type { MessageRecord, MessageRepositoryPort } from "../../db/repositories/messageRepository.js";
import type { AuditService } from "../audit/contracts/index.js";
import type { PublicConversationEventBus } from "../chat/contracts/index.js";
import type { CustomerChannelReplyDeliverer } from "../customerReplyDelivery/public.js";

export class OperatorReplyService {
  constructor(private readonly dependencies: {
    conversationRepository: Pick<ConversationRepositoryPort, "findByIdAndWorkspaceId" | "touch">;
    messageRepository: Pick<MessageRepositoryPort, "create">;
    auditService: Pick<AuditService, "record">;
    publicConversationEventBus: Pick<PublicConversationEventBus, "publish">;
    customerReplyDelivery: CustomerChannelReplyDeliverer;
    publisher?: WorkspaceInvalidationPublisher;
  }) {}

  async reply(input: {
    conversationId: string;
    workspaceId: string;
    accountId: string;
    displayName: string;
    message: string;
  }): Promise<MessageRecord> {
    const conversation = await this.dependencies.conversationRepository.findByIdAndWorkspaceId(
      input.conversationId,
      input.workspaceId,
    );
    if (!conversation) {
      throw notFound("Conversation not found");
    }

    const message = await this.dependencies.messageRepository.create({
      conversationId: input.conversationId,
      workspaceId: input.workspaceId,
      role: "assistant",
      source: "human_agent",
      content: input.message,
      operatorAccountId: input.accountId,
      operatorDisplayName: input.displayName,
    });
    await this.dependencies.conversationRepository.touch(input.conversationId, input.workspaceId);
    this.dependencies.publisher?.enqueue(input.workspaceId, ["conversation.turn_committed"]);

    await this.dependencies.auditService.record({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      eventType: "hitl.ownership",
      eventStatus: "success",
      metadata: {
        action: "replied",
        conversationId: input.conversationId,
        messageId: message.id,
        messageLength: input.message.length,
      },
    });
    this.dependencies.publicConversationEventBus.publish({
      type: "message.created",
      conversationId: input.conversationId,
      workspaceId: input.workspaceId,
      messageId: message.id,
      createdAt: message.createdAt instanceof Date ? message.createdAt.toISOString() : message.createdAt,
    });
    await this.dependencies.customerReplyDelivery.deliver({
      conversation,
      message: {
        id: message.id,
        content: message.content,
      },
    });

    return message;
  }
}
