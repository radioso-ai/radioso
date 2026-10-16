import type { WorkspaceInvalidationPublisher } from "@radioso/workspace-invalidation-contract";

import type { AuditEventInput } from "../audit/contracts/index.js";
import { notFound } from "../../shared/domain/errors.js";
import type {
  ConversationDataEraser,
  VerifiedCustomerDataEraser,
} from "../../shared/domain/conversationDataErasure.js";

/** Who asked for an erasure. A credential's identity joins the audit event from the request's own audit context. */
export interface ConversationErasureActor {
  accountId: string;
  /** The signed-in teammate, or null for a workspace credential. */
  userId: string | null;
}

/** What an erasure removed. Counts only: an erasure never reports the content it removed. */
export interface ConversationErasureReceipt {
  conversationCount: number;
  messageCount: number;
  /** Rows each owning module removed beyond what cascaded from the conversations. */
  rowsByOwner: Readonly<Record<string, number>>;
}

/**
 * Permanent erasure of a conversation, or of a visitor and every conversation they had, with
 * everything derived from them. The one entry point for HTTP and for anything else that erases a
 * data subject's conversations.
 */
export interface ConversationErasure {
  eraseConversation(input: { workspaceId: string; conversationId: string; actor: ConversationErasureActor }): Promise<ConversationErasureReceipt>;
  eraseVisitor(input: { workspaceId: string; visitorId: string; actor: ConversationErasureActor }): Promise<ConversationErasureReceipt>;
}

/** The conversations and visitor an erasure removes, as its transaction sees them. */
export interface ErasureSubjects {
  /** Locks the conversations by the conversation lock protocol and returns the ones the workspace has. */
  lockConversations(workspaceId: string, conversationIds: readonly string[]): Promise<ReadonlySet<string>>;
  /**
   * Locks the visitor's row, so no new conversation can attach to it while it is erased, and returns
   * its verified customer id and conversations. Null when the workspace has no such visitor.
   */
  lockVisitor(workspaceId: string, visitorId: string): Promise<{ verifiedCustomerId: string | null; conversationIds: readonly string[] } | null>;
  /** The chat sessions only these conversations carry in the workspace. */
  exclusiveChatSessionIds(workspaceId: string, conversationIds: readonly string[]): Promise<readonly string[]>;
  /**
   * Deletes the conversations, with everything a foreign key cascades from them, and the visitor of
   * any that was its visitor's last conversation.
   */
  deleteConversations(workspaceId: string, conversationIds: readonly string[]): Promise<{ conversations: number; messages: number }>;
  deleteVisitor(workspaceId: string, visitorId: string): Promise<void>;
}

/** One erasure transaction: its subjects, every module's erasers, and its audit record, bound to it. */
export interface ConversationErasureWriteScope {
  subjects: ErasureSubjects;
  conversationErasers: readonly ConversationDataEraser[];
  verifiedCustomerErasers: readonly VerifiedCustomerDataEraser[];
  audit: { record(event: AuditEventInput): Promise<void> };
}

export interface ConversationErasureUnitOfWork {
  run<T>(work: (scope: ConversationErasureWriteScope) => Promise<T>): Promise<T>;
}

interface ConversationErasureDependencies {
  unitOfWork: ConversationErasureUnitOfWork;
  invalidation: Pick<WorkspaceInvalidationPublisher, "enqueue">;
  /** Logs a committed audit event; the erasure's one log line. */
  auditLog: { logRecorded?(event: AuditEventInput): void };
}

type ErasureSubject =
  | { eventType: "conversation.erased"; conversationId: string }
  | { eventType: "visitor.erased"; visitorId: string };

const addRows = (rows: Record<string, number>, owner: string, count: number): void => {
  rows[owner] = (rows[owner] ?? 0) + count;
};

export class ConversationErasureService implements ConversationErasure {
  constructor(private readonly deps: ConversationErasureDependencies) {}

  async eraseConversation(input: {
    workspaceId: string;
    conversationId: string;
    actor: ConversationErasureActor;
  }): Promise<ConversationErasureReceipt> {
    return this.commit(input, { eventType: "conversation.erased", conversationId: input.conversationId }, async (scope) => {
      const locked = await scope.subjects.lockConversations(input.workspaceId, [input.conversationId]);
      if (!locked.has(input.conversationId)) {
        throw notFound("Conversation not found");
      }
      return this.eraseConversations(scope, input.workspaceId, [input.conversationId]);
    });
  }

  async eraseVisitor(input: {
    workspaceId: string;
    visitorId: string;
    actor: ConversationErasureActor;
  }): Promise<ConversationErasureReceipt> {
    return this.commit(input, { eventType: "visitor.erased", visitorId: input.visitorId }, async (scope) => {
      const visitor = await scope.subjects.lockVisitor(input.workspaceId, input.visitorId);
      if (!visitor) {
        throw notFound("Visitor not found");
      }
      const receipt = visitor.conversationIds.length > 0
        ? await this.eraseConversations(
            scope,
            input.workspaceId,
            [...await scope.subjects.lockConversations(input.workspaceId, visitor.conversationIds)],
          )
        : { conversationCount: 0, messageCount: 0, rowsByOwner: {} };
      const rowsByOwner = { ...receipt.rowsByOwner };
      if (visitor.verifiedCustomerId) {
        for (const eraser of scope.verifiedCustomerErasers) {
          addRows(rowsByOwner, eraser.owner, await eraser.eraseVerifiedCustomer({
            workspaceId: input.workspaceId,
            verifiedCustomerId: visitor.verifiedCustomerId,
          }));
        }
      }
      await scope.subjects.deleteVisitor(input.workspaceId, input.visitorId);
      return { ...receipt, rowsByOwner };
    });
  }

  /** Erasers first, while the conversations they key on still exist, then the conversations and their cascade. */
  private async eraseConversations(
    scope: ConversationErasureWriteScope,
    workspaceId: string,
    conversationIds: readonly string[],
  ): Promise<ConversationErasureReceipt> {
    const ids = [...conversationIds].sort();
    const chatSessionIds = await scope.subjects.exclusiveChatSessionIds(workspaceId, ids);
    const rowsByOwner: Record<string, number> = {};
    for (const eraser of scope.conversationErasers) {
      addRows(rowsByOwner, eraser.owner, await eraser.erase({
        kind: "conversations",
        workspaceId,
        conversationIds: ids,
        chatSessionIds,
      }));
    }
    const deleted = await scope.subjects.deleteConversations(workspaceId, ids);
    return { conversationCount: deleted.conversations, messageCount: deleted.messages, rowsByOwner };
  }

  /**
   * Runs `erase` in one transaction with its audit event, then — only once that committed — tells
   * live dashboards and logs the event. A refusal (not found) rolls everything back and records nothing.
   */
  private async commit(
    input: { workspaceId: string; actor: ConversationErasureActor },
    subject: ErasureSubject,
    erase: (scope: ConversationErasureWriteScope) => Promise<ConversationErasureReceipt>,
  ): Promise<ConversationErasureReceipt> {
    let recorded: AuditEventInput | null = null;
    const receipt = await this.deps.unitOfWork.run(async (scope) => {
      recorded = null;
      const result = await erase(scope);
      const { eventType, ...subjectIds } = subject;
      const event: AuditEventInput = {
        accountId: input.actor.accountId,
        workspaceId: input.workspaceId,
        eventType,
        eventStatus: "success",
        metadata: {
          actorUserId: input.actor.userId,
          ...subjectIds,
          conversationCount: result.conversationCount,
          messageCount: result.messageCount,
          rowsByOwner: result.rowsByOwner,
        },
      };
      await scope.audit.record(event);
      recorded = event;
      return result;
    });
    if (receipt.conversationCount > 0) {
      this.deps.invalidation.enqueue(input.workspaceId, ["conversation.deleted"]);
    }
    if (recorded) {
      this.deps.auditLog.logRecorded?.(recorded);
    }
    return receipt;
  }
}
