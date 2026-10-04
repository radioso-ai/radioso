import type { WorkspaceInvalidationPublisher } from "@radioso/workspace-invalidation-contract";
import type { ConversationRecord, ConversationRepositoryPort } from "../../db/repositories/conversationRepository.js";
import type { MessageRecord, MessageRepositoryPort } from "../../db/repositories/messageRepository.js";
import type { AuditService } from "../audit/contracts/index.js";
import type { PublicConversationEventBus } from "../chat/contracts/index.js";
import type {
  CustomerChannelReplyDeliverer,
  CustomerReplyOutboxPort,
  CustomerReplyRoute,
} from "../customerReplyDelivery/public.js";
import { notifyAfterCommit, recordCommittedOwnershipAudit, type CommittedAuditReporting } from "./committedOwnershipAudit.js";
import type { OperatorIdentity } from "./operatorIdentity.js";

/**
 * A teammate's reply as the ownership service hands it over. The caller has already checked that
 * the conversation belongs to the workspace and resolved who is replying, so neither is read again.
 */
interface OperatorReply {
  conversation: ConversationRecord;
  accountId: string;
  operator: OperatorIdentity;
  message: string;
}

/** A reply ready to write: the reply, and where it goes outside the web (null for nowhere). */
interface PreparedOperatorReply extends OperatorReply {
  channel: CustomerReplyRoute | null;
}

/**
 * Where a reply is written: the caller's transaction, so the message, the conversation's activity
 * and the reply's channel delivery commit with the ownership they stand on, or none of them does.
 */
export interface OperatorReplyWriteScope {
  messages: Pick<MessageRepositoryPort, "create">;
  conversations: Pick<ConversationRepositoryPort, "touch">;
  outbox: CustomerReplyOutboxPort;
}

/**
 * How a teammate's reply becomes a message and reaches the visitor, in steps around the caller's
 * transaction: {@link prepare} before it, {@link write} inside it, then {@link announce} and
 * {@link audit} once it has committed. Nothing visitor-facing happens for a reply that did not
 * commit, and nothing after the commit can fail one that did: a client told a committed reply
 * failed would send it again.
 */
export class OperatorReplyService {
  constructor(private readonly dependencies: {
    auditService: Pick<AuditService, "record">;
    publicConversationEventBus: Pick<PublicConversationEventBus, "publish">;
    customerReplyDelivery: Pick<CustomerChannelReplyDeliverer, "route">;
    publisher?: WorkspaceInvalidationPublisher;
  } & CommittedAuditReporting) {}

  /**
   * Resolves where the reply goes outside the web before its transaction opens: that can call the
   * channel's provider, which must not hold the transaction's locks. A failure here fails the reply
   * before anything is written, so sending it again is safe.
   */
  async prepare(reply: OperatorReply): Promise<PreparedOperatorReply> {
    return { ...reply, channel: await this.dependencies.customerReplyDelivery.route(reply.conversation) };
  }

  /**
   * Writes the reply attributed to the teammate and signed with their reply signature, which is
   * never an email (with no signature the reply goes out unsigned); dates the conversation's
   * activity; and queues the reply's channel delivery, keyed by the message so it goes out once.
   */
  async write(scope: OperatorReplyWriteScope, reply: PreparedOperatorReply): Promise<MessageRecord> {
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
    await reply.channel?.enqueue(scope.outbox, { id: message.id, content: message.content });
    return message;
  }

  /** Once the reply has committed: pushes it to the visitor's open chat and refreshes the dashboard. */
  announce(reply: OperatorReply, message: MessageRecord): void {
    const { conversation } = reply;
    const committed = {
      accountId: reply.accountId,
      workspaceId: conversation.workspaceId,
      conversationId: conversation.id,
      messageId: message.id,
    };
    notifyAfterCommit(this.dependencies, { ...committed, notification: "visitor_push" }, () => {
      this.dependencies.publicConversationEventBus.publish({
        type: "message.created",
        conversationId: conversation.id,
        workspaceId: conversation.workspaceId,
        messageId: message.id,
        createdAt: message.createdAt instanceof Date ? message.createdAt.toISOString() : message.createdAt,
      });
    });
    notifyAfterCommit(this.dependencies, { ...committed, notification: "dashboard_refresh" }, () => {
      this.dependencies.publisher?.enqueue(conversation.workspaceId, ["conversation.turn_committed"]);
    });
  }

  /** Once the reply has committed: records its `hitl.ownership` audit event. */
  audit(reply: OperatorReply, message: MessageRecord): Promise<void> {
    return recordCommittedOwnershipAudit({ ...this.dependencies, audit: this.dependencies.auditService }, {
      accountId: reply.accountId,
      workspaceId: reply.conversation.workspaceId,
      metadata: {
        action: "replied",
        actorUserId: reply.operator.userId,
        conversationId: reply.conversation.id,
        messageId: message.id,
        messageLength: reply.message.length,
      },
    });
  }
}
