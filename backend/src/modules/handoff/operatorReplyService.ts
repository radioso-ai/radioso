import { notFound } from "../../shared/domain/errors.js";
import type { WorkspaceInvalidationPublisher } from "@radioso/workspace-invalidation-contract";
import type { ConversationRepositoryPort } from "../../db/repositories/conversationRepository.js";
import type { MessageRecord, MessageRepositoryPort } from "../../db/repositories/messageRepository.js";
import type { AuditService } from "../audit/contracts/index.js";
import type { PublicConversationEventBus } from "../chat/contracts/index.js";
import type { CustomerChannelReplyDeliverer } from "../customerReplyDelivery/public.js";
import type { OperatorIdentityResolver } from "./operatorIdentity.js";

export class OperatorReplyService {
  constructor(private readonly dependencies: {
    conversationRepository: Pick<ConversationRepositoryPort, "findByIdAndWorkspaceId" | "touch">;
    messageRepository: Pick<MessageRepositoryPort, "create">;
    auditService: Pick<AuditService, "record">;
    publicConversationEventBus: Pick<PublicConversationEventBus, "publish">;
    customerReplyDelivery: CustomerChannelReplyDeliverer;
    operatorIdentities: Pick<OperatorIdentityResolver, "resolve">;
    publisher?: WorkspaceInvalidationPublisher;
  }) {}

  /**
   * Sends a teammate's reply to the visitor. The message is attributed to the teammate and
   * signed with their reply signature, which is never an email; with no signature the reply goes
   * out unsigned.
   */
  async reply(input: {
    conversationId: string;
    workspaceId: string;
    accountId: string;
    userId: string;
    message: string;
  }): Promise<MessageRecord> {
    const conversation = await this.dependencies.conversationRepository.findByIdAndWorkspaceId(
      input.conversationId,
      input.workspaceId,
    );
    if (!conversation) {
      throw notFound("Conversation not found");
    }
    const operator = await this.dependencies.operatorIdentities.resolve({
      accountId: input.accountId,
      userId: input.userId,
    });

    const message = await this.dependencies.messageRepository.create({
      conversationId: input.conversationId,
      workspaceId: input.workspaceId,
      role: "assistant",
      source: "human_agent",
      content: input.message,
      operatorAccountId: input.accountId,
      operatorUserId: operator.userId,
      operatorDisplayName: operator.replySignature ?? undefined,
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
        actorUserId: operator.userId,
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
