import type { WorkspaceInvalidationPublisher } from "@radioso/workspace-invalidation-contract";

import type { AuditEventInput } from "../audit/contracts/index.js";
import { notFound } from "../../shared/domain/errors.js";
import type {
  ConversationDataEraser,
  VendorHeldConversationDataEraser,
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
  /**
   * What vendors hold for the erased conversations, such as a voice call's recording: read inside
   * the erasure, before any eraser or the cascade removes the rows that say where it is, and erased
   * at the vendor once the erasure committed. It never fails the erasure.
   */
  vendorHeldData?: VendorHeldConversationDataEraser;
}

/** What an erasure leaves for after its commit: the vendors' copies, read while the transaction ran. */
type AfterCommit = (erase: () => Promise<void>) => void;

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
    return this.commit(input, { eventType: "conversation.erased", conversationId: input.conversationId }, async (scope, afterCommit) => {
      const locked = await scope.subjects.lockConversations(input.workspaceId, [input.conversationId]);
      if (!locked.has(input.conversationId)) {
        throw notFound("Conversation not found");
      }
      return this.eraseConversations(scope, input, [input.conversationId], afterCommit);
    });
  }

  async eraseVisitor(input: {
    workspaceId: string;
    visitorId: string;
    actor: ConversationErasureActor;
  }): Promise<ConversationErasureReceipt> {
    return this.commit(input, { eventType: "visitor.erased", visitorId: input.visitorId }, async (scope, afterCommit) => {
      const visitor = await scope.subjects.lockVisitor(input.workspaceId, input.visitorId);
      if (!visitor) {
        throw notFound("Visitor not found");
      }
      const receipt = visitor.conversationIds.length > 0
        ? await this.eraseConversations(
            scope,
            input,
            [...await scope.subjects.lockConversations(input.workspaceId, visitor.conversationIds)],
            afterCommit,
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

  /**
   * What vendors hold first, read before anything removes where it is; then the erasers, while the
   * conversations they key on still exist; then the conversations and their cascade.
   */
  private async eraseConversations(
    scope: ConversationErasureWriteScope,
    input: { workspaceId: string; actor: ConversationErasureActor },
    conversationIds: readonly string[],
    afterCommit: AfterCommit,
  ): Promise<ConversationErasureReceipt> {
    const { workspaceId } = input;
    const ids = [...conversationIds].sort();
    if (this.deps.vendorHeldData) {
      const vendorHeld = await this.deps.vendorHeldData.prepare({
        account: { id: input.actor.accountId, deleted: false },
        scopes: [{ kind: "conversations", workspaceId, conversationIds: ids }],
      });
      afterCommit(() => vendorHeld.erase());
    }
    const rowsByOwner: Record<string, number> = {};
    for (const eraser of scope.conversationErasers) {
      addRows(rowsByOwner, eraser.owner, await eraser.erase({ kind: "conversations", workspaceId, conversationIds: ids }));
    }
    const deleted = await scope.subjects.deleteConversations(workspaceId, ids);
    return { conversationCount: deleted.conversations, messageCount: deleted.messages, rowsByOwner };
  }

  /**
   * Runs `erase` in one transaction with its audit event, then — only once that committed — tells
   * live dashboards, logs the event, and asks the vendors to delete their copies. A refusal (not
   * found) rolls everything back, records nothing and asks the vendors nothing; a transaction that
   * runs again reads the vendors' copies again, and only the run that committed is erased.
   */
  private async commit(
    input: { workspaceId: string; actor: ConversationErasureActor },
    subject: ErasureSubject,
    erase: (scope: ConversationErasureWriteScope, afterCommit: AfterCommit) => Promise<ConversationErasureReceipt>,
  ): Promise<ConversationErasureReceipt> {
    let recorded: AuditEventInput | null = null;
    let vendorErasures: Array<() => Promise<void>> = [];
    const receipt = await this.deps.unitOfWork.run(async (scope) => {
      recorded = null;
      vendorErasures = [];
      const result = await erase(scope, (eraseAtVendor) => vendorErasures.push(eraseAtVendor));
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
    for (const eraseAtVendor of vendorErasures) {
      await eraseAtVendor().catch(() => undefined);
    }
    return receipt;
  }
}
