import type { WorkspaceInvalidationPublisher } from "@radioso/workspace-invalidation-contract";

import type { AuditEventInput } from "../audit/contracts/index.js";
import { notFound } from "../../shared/domain/errors.js";
import type {
  ConversationDataEraser,
  VendorHeldConversationDataEraser,
  VendorHeldConversationDataScope,
  VerifiedCustomerDataEraser,
  VisitorKeyDataEraser,
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
   * its verified customer id, its durable key and its conversations. Null when the workspace has no
   * such visitor.
   */
  lockVisitor(workspaceId: string, visitorId: string): Promise<{
    verifiedCustomerId: string | null;
    visitorKey: string | null;
    conversationIds: readonly string[];
  } | null>;
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
  /** Rows a visitor left by their key before any conversation of theirs, such as a call never answered. */
  visitorKeyErasers: readonly VisitorKeyDataEraser[];
  /**
   * What vendors hold for the erased subjects, such as a voice call's recording: read in this
   * transaction, with its rows locked, before any eraser or the cascade removes the rows that say
   * where it is, and erased at the vendor once the transaction committed. Its read rejecting fails
   * the erasure. Null when nothing is held outside Radioso.
   */
  vendorHeldData: VendorHeldConversationDataEraser | null;
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
      const ids = [input.conversationId];
      await this.readVendorHeld(scope, input, [{ kind: "conversations", workspaceId: input.workspaceId, conversationIds: ids }], afterCommit);
      return this.eraseConversations(scope, input.workspaceId, ids);
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
      const conversationIds = visitor.conversationIds.length > 0
        ? [...await scope.subjects.lockConversations(input.workspaceId, visitor.conversationIds)]
        : [];
      // One read for everything vendors hold for the visitor: their conversations, and what they
      // left by their key before any conversation, such as a call whose first turn never came.
      await this.readVendorHeld(scope, input, [
        ...(conversationIds.length > 0 ? [{ kind: "conversations" as const, workspaceId: input.workspaceId, conversationIds }] : []),
        ...(visitor.visitorKey ? [{ kind: "visitor_key" as const, workspaceId: input.workspaceId, visitorKey: visitor.visitorKey }] : []),
      ], afterCommit);
      const receipt = conversationIds.length > 0
        ? await this.eraseConversations(scope, input.workspaceId, conversationIds)
        : { conversationCount: 0, messageCount: 0, rowsByOwner: {} };
      const rowsByOwner = { ...receipt.rowsByOwner };
      if (visitor.visitorKey) {
        for (const eraser of scope.visitorKeyErasers) {
          addRows(rowsByOwner, eraser.owner, await eraser.eraseVisitorKey({ workspaceId: input.workspaceId, visitorKey: visitor.visitorKey }));
        }
      }
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
   * Reads what vendors hold for the erased subjects, in the erasure's transaction and before any
   * eraser runs, and leaves its deletion at the vendor for after the commit. A read that rejects
   * fails the erasure.
   */
  private async readVendorHeld(
    scope: ConversationErasureWriteScope,
    input: { actor: ConversationErasureActor },
    scopes: readonly VendorHeldConversationDataScope[],
    afterCommit: AfterCommit,
  ): Promise<void> {
    if (!scope.vendorHeldData || scopes.length === 0) return;
    const vendorHeld = await scope.vendorHeldData.prepare({ account: { id: input.actor.accountId, deleted: false }, scopes });
    afterCommit(() => vendorHeld.erase());
  }

  /** Erasers first, while the conversations they key on still exist, then the conversations and their cascade. */
  private async eraseConversations(
    scope: ConversationErasureWriteScope,
    workspaceId: string,
    conversationIds: readonly string[],
  ): Promise<ConversationErasureReceipt> {
    const ids = [...conversationIds].sort();
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
