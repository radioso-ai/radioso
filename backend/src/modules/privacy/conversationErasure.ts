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

/**
 * The erasure a workspace's retention window asks for, through the same erasers and cascade as a
 * requested one. Its own port, since only the retention sweep calls it.
 */
export interface InactiveConversationErasure {
  /**
   * Erases up to `limit` of a workspace's conversations with no activity since `inactiveBefore`.
   * Nobody requested it, so its record names the system as the actor, and a batch that finds
   * nothing records nothing.
   */
  eraseInactiveConversations(input: InactiveConversationBatch): Promise<InactiveConversationErasureReceipt>;
}

/**
 * A retention batch's receipt. `claimedCount` is how many conversations the batch claimed before
 * the recheck under their locks dropped any a message reached meanwhile: a full claim means more may
 * be waiting, however few were erased.
 */
export interface InactiveConversationErasureReceipt extends ConversationErasureReceipt {
  claimedCount: number;
}

/** One batch of a workspace's retention: the conversations its window has passed. */
export interface InactiveConversationBatch {
  workspaceId: string;
  /** The workspace's organization, which the audit event and the vendors' erasure name. */
  accountId: string;
  inactiveBefore: Date;
  /** The window that set `inactiveBefore`, stated on the audit event. */
  retentionDays: number;
  limit: number;
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
  /**
   * Locks up to `limit` of the workspace's conversations with no update and no message since
   * `inactiveBefore`, by the conversation lock protocol, and returns them. A conversation another unit
   * holds is skipped rather than waited for, so two sweeps never claim the same one, and each is
   * checked again once locked, so one a message reached meanwhile is left alone.
   */
  lockInactiveConversations(workspaceId: string, inactiveBefore: Date, limit: number): Promise<{
    /** How many the claim took, before the recheck. */
    claimed: number;
    /** The claimed conversations still without activity, which the erasure removes. */
    inactive: readonly string[];
  }>;
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
   * where it is, and handed to a durable backlog in it, so a background job deletes it at the vendor
   * once the transaction committed. Its read rejecting fails the erasure. Null when nothing is held
   * outside Radioso.
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

/** What an erasure leaves for after its commit: the wake of the job that deletes the vendors' copies it handed off. */
type AfterCommit = (work: () => Promise<void>) => void;

/** Who an erasure's audit event names, and what it says beyond the counts; null records nothing. */
type ErasureRecord = (receipt: ConversationErasureReceipt) => { eventType: string; metadata: Record<string, unknown> } | null;

const requestedErasure = (actor: ConversationErasureActor, subject: Record<string, string>, eventType: string): ErasureRecord =>
  () => ({ eventType, metadata: { actorUserId: actor.userId, ...subject } });

const addRows = (rows: Record<string, number>, owner: string, count: number): void => {
  rows[owner] = (rows[owner] ?? 0) + count;
};

export class ConversationErasureService implements ConversationErasure, InactiveConversationErasure {
  constructor(private readonly deps: ConversationErasureDependencies) {}

  async eraseConversation(input: {
    workspaceId: string;
    conversationId: string;
    actor: ConversationErasureActor;
  }): Promise<ConversationErasureReceipt> {
    const record = requestedErasure(input.actor, { conversationId: input.conversationId }, "conversation.erased");
    return this.commit(input.workspaceId, input.actor.accountId, record, async (scope, afterCommit) => {
      const locked = await scope.subjects.lockConversations(input.workspaceId, [input.conversationId]);
      if (!locked.has(input.conversationId)) {
        throw notFound("Conversation not found");
      }
      const ids = [input.conversationId];
      await this.handOffVendorHeld(scope, input.actor.accountId, [{ kind: "conversations", workspaceId: input.workspaceId, conversationIds: ids }], afterCommit);
      return this.eraseConversations(scope, input.workspaceId, ids);
    });
  }

  async eraseVisitor(input: {
    workspaceId: string;
    visitorId: string;
    actor: ConversationErasureActor;
  }): Promise<ConversationErasureReceipt> {
    const record = requestedErasure(input.actor, { visitorId: input.visitorId }, "visitor.erased");
    return this.commit(input.workspaceId, input.actor.accountId, record, async (scope, afterCommit) => {
      const visitor = await scope.subjects.lockVisitor(input.workspaceId, input.visitorId);
      if (!visitor) {
        throw notFound("Visitor not found");
      }
      const conversationIds = visitor.conversationIds.length > 0
        ? [...await scope.subjects.lockConversations(input.workspaceId, visitor.conversationIds)]
        : [];
      // One hand-off for everything vendors hold for the visitor: their conversations, and what they
      // left by their key before any conversation, such as a call whose first turn never came.
      await this.handOffVendorHeld(scope, input.actor.accountId, [
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

  async eraseInactiveConversations(input: InactiveConversationBatch): Promise<InactiveConversationErasureReceipt> {
    // The schedule acting on its own: stated rather than left absent, so a reader of the audit trail
    // can tell a retention erasure from a request that lost its attribution.
    const record: ErasureRecord = (receipt) => receipt.conversationCount === 0 ? null : {
      eventType: "conversation.retention.enforced",
      metadata: { principalType: "system", retentionDays: input.retentionDays, cutoff: input.inactiveBefore.toISOString() },
    };
    let claimedCount = 0;
    const receipt = await this.commit(input.workspaceId, input.accountId, record, async (scope, afterCommit) => {
      const { claimed, inactive } = await scope.subjects.lockInactiveConversations(input.workspaceId, input.inactiveBefore, input.limit);
      claimedCount = claimed;
      if (inactive.length === 0) {
        return { conversationCount: 0, messageCount: 0, rowsByOwner: {} };
      }
      await this.handOffVendorHeld(scope, input.accountId, [{ kind: "conversations", workspaceId: input.workspaceId, conversationIds: inactive }], afterCommit);
      return this.eraseConversations(scope, input.workspaceId, inactive);
    });
    return { ...receipt, claimedCount };
  }

  /**
   * Hands what vendors hold for the erased subjects to the backlog, in the erasure's transaction and
   * before any eraser runs, and leaves the wake of the job that deletes it for after the commit. A
   * read that rejects fails the erasure.
   */
  private async handOffVendorHeld(
    scope: ConversationErasureWriteScope,
    accountId: string,
    scopes: readonly VendorHeldConversationDataScope[],
    afterCommit: AfterCommit,
  ): Promise<void> {
    if (!scope.vendorHeldData || scopes.length === 0) return;
    const handedOff = await scope.vendorHeldData.handOff({ accountId, scopes });
    afterCommit(() => handedOff.afterCommit());
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
   * Runs `erase` in one transaction with its audit event (none when `record` returns null), then —
   * only once that committed — tells live dashboards, logs the event, and wakes the job that deletes
   * the vendors' copies. A refusal (not found) rolls everything back, records nothing and hands
   * nothing off; a transaction that runs again hands the vendors' copies off again, and only the
   * run that committed leaves a backlog.
   */
  private async commit(
    workspaceId: string,
    accountId: string,
    record: ErasureRecord,
    erase: (scope: ConversationErasureWriteScope, afterCommit: AfterCommit) => Promise<ConversationErasureReceipt>,
  ): Promise<ConversationErasureReceipt> {
    let recorded: AuditEventInput | null = null;
    let afterCommits: Array<() => Promise<void>> = [];
    const receipt = await this.deps.unitOfWork.run(async (scope) => {
      recorded = null;
      afterCommits = [];
      const result = await erase(scope, (work) => afterCommits.push(work));
      const subject = record(result);
      if (!subject) return result;
      const event: AuditEventInput = {
        accountId,
        workspaceId,
        eventType: subject.eventType,
        eventStatus: "success",
        metadata: {
          ...subject.metadata,
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
      this.deps.invalidation.enqueue(workspaceId, ["conversation.deleted"]);
    }
    if (recorded) {
      this.deps.auditLog.logRecorded?.(recorded);
    }
    for (const work of afterCommits) {
      await work().catch(() => undefined);
    }
    return receipt;
  }
}
