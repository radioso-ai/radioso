import type { WorkspaceInvalidationPublisher } from "@radioso/workspace-invalidation-contract";
import type { ConversationRecord, ConversationRepositoryPort } from "../../db/repositories/conversationRepository.js";
import type { MessageRecord, MessageRepositoryPort } from "../../db/repositories/messageRepository.js";
import type { AuditService } from "../audit/contracts/index.js";
import type { PublicConversationEventBus } from "../chat/contracts/index.js";
import type { CustomerChannelReplyDeliverer } from "../customerReplyDelivery/public.js";
import { recordCommittedOwnershipAudit, type CommittedAuditReporting } from "./committedOwnershipAudit.js";
import type { OperatorIdentity } from "./operatorIdentity.js";

/**
 * A teammate's reply as the ownership service hands it over. The caller has already checked that
 * the conversation belongs to the workspace and resolved who is replying, so neither is read again.
 */
export interface OperatorReply {
  conversation: ConversationRecord;
  accountId: string;
  operator: OperatorIdentity;
  message: string;
}

/** Where a reply is written: the caller's transaction, so it commits with the ownership it stands on. */
export interface OperatorReplyWriteScope {
  messages: Pick<MessageRepositoryPort, "create">;
  conversations: Pick<ConversationRepositoryPort, "touch">;
}

/**
 * How a teammate's reply becomes a message and reaches the visitor, in two steps around the
 * caller's commit: {@link write} inside it, {@link deliver} after it, so nothing visitor-facing
 * happens for a reply that did not commit.
 */
export class OperatorReplyService {
  constructor(private readonly dependencies: {
    auditService: Pick<AuditService, "record">;
    publicConversationEventBus: Pick<PublicConversationEventBus, "publish">;
    customerReplyDelivery: CustomerChannelReplyDeliverer;
    publisher?: WorkspaceInvalidationPublisher;
  } & CommittedAuditReporting) {}

  /**
   * Writes the reply attributed to the teammate and signed with their reply signature, which is
   * never an email; with no signature the reply goes out unsigned.
   */
  async write(scope: OperatorReplyWriteScope, reply: OperatorReply): Promise<MessageRecord> {
    const { conversation, operator } = reply;
    const message = await scope.messages.create({
      conversationId: conversation.id,
      workspaceId: conversation.workspaceId,
      role: "assistant",
      source: "human_agent",
      content: reply.message,
      operatorAccountId: reply.accountId,
      operatorUserId: operator.userId,
      operatorDisplayName: operator.replySignature ?? undefined,
    });
    await scope.conversations.touch(conversation.id, conversation.workspaceId);
    return message;
  }

  /** Once the reply has committed: refreshes the dashboard, audits it, and sends it to the visitor. */
  async deliver(reply: OperatorReply, message: MessageRecord): Promise<void> {
    const { conversation } = reply;
    this.dependencies.publisher?.enqueue(conversation.workspaceId, ["conversation.turn_committed"]);

    await recordCommittedOwnershipAudit({ ...this.dependencies, audit: this.dependencies.auditService }, {
      accountId: reply.accountId,
      workspaceId: conversation.workspaceId,
      metadata: {
        action: "replied",
        actorUserId: reply.operator.userId,
        conversationId: conversation.id,
        messageId: message.id,
        messageLength: reply.message.length,
      },
    });
    this.dependencies.publicConversationEventBus.publish({
      type: "message.created",
      conversationId: conversation.id,
      workspaceId: conversation.workspaceId,
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
  }
}
