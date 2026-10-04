import type { WorkspaceInvalidationPublisher } from "@radioso/workspace-invalidation-contract";

import type {
  ConversationOwnershipMutationResult,
  ConversationOwnershipRepository,
} from "../../db/repositories/conversationOwnershipRepository.js";
import type {
  ConversationRecord,
  ConversationRepository,
  ConversationRepositoryPort,
} from "../../db/repositories/conversationRepository.js";
import type { MessageRecord } from "../../db/repositories/messageRepository.js";
import { AppError, notFound } from "../../shared/domain/errors.js";
import type { AuditService } from "../audit/contracts/index.js";
import type { ConversationActivityEvent, ConversationActivityWriter } from "../conversationActivity/contracts/index.js";
import { notifyAfterCommit, recordCommittedOwnershipAudit, type CommittedAuditReporting } from "./committedOwnershipAudit.js";
import type { ConversationOperatorDirectory } from "./conversationOperatorDirectory.js";
import type { OperatorIdentity, OperatorIdentityResolver } from "./operatorIdentity.js";
import type { OperatorReplyService, OperatorReplyWriteScope } from "./operatorReplyService.js";
import type { ConversationOwnershipRecord } from "./ownershipState.js";
import { transferNoticeRequest, type TransferNoticeOutboxPort } from "./transferNotice.js";

/** The signed-in teammate acting on a conversation, in the workspace they act from. */
export interface OwnershipActor {
  accountId: string;
  userId: string;
  workspaceId: string;
}

/**
 * Why a command changed nothing: the conversation moved on since the caller last saw it, or a
 * teammate other than the caller holds it.
 */
type OwnershipRefusal = "stale" | "held_by_teammate";

type OwnershipRefused = { ok: false; refusal: OwnershipRefusal; record: ConversationOwnershipRecord | null };

type OwnershipCommandResult =
  | { ok: true; changed: boolean; record: ConversationOwnershipRecord }
  | OwnershipRefused;

type OwnershipReplyResult =
  | { ok: true; message: MessageRecord; record: ConversationOwnershipRecord }
  | OwnershipRefused;

/**
 * Writes an ownership change — a claim, a transfer, a hand-back — with the activity it records and
 * the notice a transfer owes, as one unit: all commit, or none does.
 */
export interface OwnershipChangeUnitOfWork {
  run<T>(work: (scope: {
    ownership: Pick<ConversationOwnershipRepository, "loadForUpdate" | "takeOver" | "transfer" | "handBack">;
    outbox: TransferNoticeOutboxPort;
    activity: ConversationActivityWriter;
  }) => Promise<T>): Promise<T>;
}

/**
 * Writes a reply, its channel delivery, and the ownership it stands on — with the activity of a
 * claim the reply makes — as one unit: the conversation and ownership rows stay locked from the
 * moment they are read until the message is written, so a transfer or hand-back either commits
 * before the reply looks (and refuses it) or waits until the reply has committed. A delivery queued
 * in it is pushed to the action worker once it commits.
 */
export interface OwnershipReplyUnitOfWork {
  run<T>(work: (scope: {
    conversations: Pick<ConversationRepository, "lockForUpdate">;
    ownership: Pick<ConversationOwnershipRepository, "loadForUpdate" | "takeOver">;
    reply: OperatorReplyWriteScope;
    activity: ConversationActivityWriter;
  }) => Promise<T>): Promise<T>;
}

/** Audit metadata a surface adds to the records its commands cause, e.g. the Slack user who clicked. */
type OwnershipAuditContext = Record<string, unknown>;

type SettledChange = Extract<ConversationOwnershipMutationResult, { ok: true }>;

type OwnershipAuditMetadata = Record<string, unknown> & { action: string; conversationId: string };

/** A transfer target that is not a teammate able to own conversations here; never says which. */
const transferTargetUnavailable = (): AppError =>
  new AppError(404, "transfer_target_unavailable", "Transfer target not found");

const heldByTeammate = (record: ConversationOwnershipRecord | null, userId: string): boolean =>
  record?.state === "human_owned" && record.ownerUserId !== null && record.ownerUserId !== userId;

const refusalFor = (record: ConversationOwnershipRecord | null, actor: OwnershipActor): OwnershipRefused => ({
  ok: false,
  refusal: heldByTeammate(record, actor.userId) ? "held_by_teammate" : "stale",
  record,
});

const claimedActivity = (actor: OwnershipActor, conversationId: string): ConversationActivityEvent => ({
  kind: "claimed",
  conversationId,
  workspaceId: actor.workspaceId,
  actorUserId: actor.userId,
});

/**
 * The rules for who handles a human-owned conversation, keyed on the teammate acting. Every
 * surface — the dashboard's REST routes, Slack's buttons — goes through here, so none restates
 * them:
 * - a conversation is claimed when it names a teammate (`ownerUserId`); a handoff nobody has
 *   claimed, and an AI-owned conversation, can be taken over by any teammate;
 * - only the owner replies or hands back; replying to an unclaimed or AI-owned conversation
 *   claims it for the replier first, and a reply commits with the ownership it was checked against
 *   and with its delivery to the customer's channel;
 * - taking a conversation a teammate holds is an explicit transfer to yourself;
 * - every change commits with the activity that records it, and a transfer with the notice it owes
 *   the recipient;
 * - a committed change stands even when what follows it — telling the visitor and the dashboard,
 *   and its audit record — fails.
 */
export class ConversationOwnershipService {
  constructor(private readonly dependencies: {
    conversations: Pick<ConversationRepositoryPort, "findByIdAndWorkspaceId">;
    ownership: Pick<ConversationOwnershipRepository, "load">;
    changes: OwnershipChangeUnitOfWork;
    replyWrites: OwnershipReplyUnitOfWork;
    operators: Pick<ConversationOperatorDirectory, "find">;
    operatorIdentities: Pick<OperatorIdentityResolver, "resolve">;
    replies: Pick<OperatorReplyService, "prepare" | "write" | "announce" | "audit">;
    audit: Pick<AuditService, "record">;
    publisher?: WorkspaceInvalidationPublisher;
  } & CommittedAuditReporting) {}

  /** The conversation's ownership now; null while no teammate has ever been involved. */
  async load(conversationId: string): Promise<ConversationOwnershipRecord | null> {
    return this.dependencies.ownership.load(conversationId);
  }

  /**
   * Claims a conversation the AI owns or nobody has claimed. One a teammate holds is refused:
   * taking it from them is an explicit {@link transfer} to yourself. Taking over a conversation
   * you already hold changes nothing.
   */
  async takeOver(actor: OwnershipActor, input: {
    conversationId: string;
    reason?: string;
    auditContext?: OwnershipAuditContext;
  }): Promise<OwnershipCommandResult> {
    const [, operator] = await this.readConversationAndOperator(actor, input.conversationId);
    const result = await this.dependencies.changes.run(async ({ ownership, activity }) => {
      const claimed = await ownership.takeOver(this.claimInput(actor, operator, input));
      if (claimed.ok && claimed.changed) {
        await activity.record(claimedActivity(actor, input.conversationId));
      }
      return claimed;
    });
    if (result.ok) {
      await this.settle(actor, result, this.claimAudit(actor, input));
      return result;
    }
    if (result.record?.state === "human_owned" && result.record.ownerUserId === actor.userId) {
      return { ok: true, changed: false, record: result.record };
    }
    return refusalFor(result.record, actor);
  }

  /** Hands a human-owned conversation to a teammate, or to the caller to take it from whoever holds it. */
  async transfer(actor: OwnershipActor, input: {
    conversationId: string;
    toUserId: string;
    expectedVersion: number;
    auditContext?: OwnershipAuditContext;
  }): Promise<OwnershipCommandResult> {
    await this.requireConversation(actor, input.conversationId);
    const target = await this.dependencies.operators.find({
      accountId: actor.accountId,
      workspaceId: actor.workspaceId,
      userId: input.toUserId,
    });
    if (!target) {
      throw transferTargetUnavailable();
    }
    const result = await this.dependencies.changes.run(async ({ ownership, outbox, activity }) => {
      // Locked until the transfer commits, so the teammate it names as the previous owner is the
      // one the transfer took it from.
      const previous = await ownership.loadForUpdate(input.conversationId);
      const transferred = await ownership.transfer({
        conversationId: input.conversationId,
        accountId: actor.accountId,
        userId: target.userId,
        displayName: target.label,
        expectedVersion: input.expectedVersion,
      });
      const notice = transferred.ok && transferred.changed
        ? transferNoticeRequest({
            accountId: actor.accountId,
            workspaceId: actor.workspaceId,
            conversationId: input.conversationId,
            ownershipVersion: transferred.record.version,
            actorUserId: actor.userId,
            recipientUserId: target.userId,
          })
        : null;
      if (transferred.ok && transferred.changed) {
        await activity.record({
          kind: "reassigned",
          conversationId: input.conversationId,
          workspaceId: actor.workspaceId,
          actorUserId: actor.userId,
          subjectUserId: target.userId,
          detail: { fromUserId: previous?.ownerUserId ?? null },
        });
      }
      if (notice) {
        await outbox.enqueue(notice);
      }
      return transferred;
    });
    if (!result.ok) {
      return refusalFor(result.record, actor);
    }
    await this.settle(actor, result, {
      action: "transferred",
      conversationId: input.conversationId,
      targetUserId: target.userId,
      ...input.auditContext,
    });
    return result;
  }

  /** Returns the conversation to the AI. Only its owner may, or anyone while nobody has claimed it. */
  async handBack(actor: OwnershipActor, input: {
    conversationId: string;
    expectedVersion: number;
    auditContext?: OwnershipAuditContext;
  }): Promise<OwnershipCommandResult> {
    await this.requireConversation(actor, input.conversationId);
    const result = await this.dependencies.changes.run(async ({ ownership, activity }) => {
      const handedBack = await ownership.handBack({
        conversationId: input.conversationId,
        expectedVersion: input.expectedVersion,
        actingUserId: actor.userId,
      });
      if (handedBack.ok && handedBack.changed) {
        await activity.record({
          kind: "handed_back",
          conversationId: input.conversationId,
          workspaceId: actor.workspaceId,
          actorUserId: actor.userId,
        });
      }
      return handedBack;
    });
    if (!result.ok) {
      return refusalFor(result.record, actor);
    }
    await this.settle(actor, result, {
      action: "handed_back",
      conversationId: input.conversationId,
      ...input.auditContext,
    });
    return result;
  }

  /** The teammate holding the conversation when it is not the caller, so the caller may not reply. */
  async replyRefusal(actor: OwnershipActor, conversationId: string): Promise<{
    refusal: "held_by_teammate";
    record: ConversationOwnershipRecord;
  } | null> {
    const record = await this.dependencies.ownership.load(conversationId);
    return record && heldByTeammate(record, actor.userId) ? { refusal: "held_by_teammate", record } : null;
  }

  /**
   * Sends the caller's reply to the visitor. The owner replies at the version they saw; a
   * conversation the AI owns or nobody has claimed is claimed for the caller first; one a teammate
   * holds is refused. `expectedVersion` omitted skips the stale-view check. The check, the claim,
   * the message and its delivery to the customer's channel commit together under the conversation
   * and ownership rows' locks; the visitor hears of the reply only after it has committed, and
   * nothing after the commit fails it.
   */
  async reply(actor: OwnershipActor, input: {
    conversationId: string;
    message: string;
    expectedVersion?: number;
    auditContext?: OwnershipAuditContext;
  }): Promise<OwnershipReplyResult> {
    const [conversation, operator] = await this.readConversationAndOperator(actor, input.conversationId);
    const reply = await this.dependencies.replies.prepare({
      conversation,
      accountId: actor.accountId,
      operator,
      message: input.message,
    });

    const outcome = await this.dependencies.replyWrites.run(async (scope): Promise<
      { ok: true; message: MessageRecord; record: ConversationOwnershipRecord; claim: SettledChange | null } | OwnershipRefused
    > => {
      // Lock order: the conversation row, then its ownership row — the order a conversation or
      // workspace delete takes them (it deletes the conversation, then the ownership row cascades),
      // so the two never deadlock. Holding the conversation first also queues this message behind
      // any writer already holding it, so the message dates after theirs and no cursor tail skips it.
      if (!(await scope.conversations.lockForUpdate(conversation.id, conversation.workspaceId))) {
        throw notFound("Conversation not found");
      }
      const current = await scope.ownership.loadForUpdate(input.conversationId);
      if (heldByTeammate(current, actor.userId)) {
        return { ok: false, refusal: "held_by_teammate", record: current };
      }
      let record: ConversationOwnershipRecord;
      let claim: SettledChange | null = null;
      if (current?.state === "human_owned" && current.ownerUserId === actor.userId) {
        if (input.expectedVersion !== undefined && current.version !== input.expectedVersion) {
          return { ok: false, refusal: "stale", record: current };
        }
        record = current;
      } else {
        const claimed = await scope.ownership.takeOver(this.claimInput(actor, operator, input));
        if (!claimed.ok) {
          return refusalFor(claimed.record, actor);
        }
        if (claimed.changed) {
          await scope.activity.record(claimedActivity(actor, input.conversationId));
        }
        record = claimed.record;
        claim = claimed;
      }
      const message = await this.dependencies.replies.write(scope.reply, reply);
      return { ok: true, message, record, claim };
    });
    if (!outcome.ok) {
      return outcome;
    }

    // Committed. The visitor and the dashboard hear first; the audits only record what happened,
    // so they run after, side by side.
    this.dependencies.replies.announce(reply, outcome.message);
    if (outcome.claim) {
      this.announceChange(actor, outcome.claim);
    }
    await Promise.all([
      outcome.claim ? this.auditChange(actor, this.claimAudit(actor, input)) : undefined,
      this.dependencies.replies.audit(reply, outcome.message),
    ]);
    return { ok: true, message: outcome.message, record: outcome.record };
  }

  /** The conversation, checked to be in the actor's workspace, and who the actor is: read together. */
  private readConversationAndOperator(
    actor: OwnershipActor,
    conversationId: string,
  ): Promise<[ConversationRecord, OperatorIdentity]> {
    return Promise.all([this.requireConversation(actor, conversationId), this.resolveOperator(actor)]);
  }

  private resolveOperator(actor: OwnershipActor): Promise<OperatorIdentity> {
    return this.dependencies.operatorIdentities.resolve({ accountId: actor.accountId, userId: actor.userId });
  }

  private claimInput(actor: OwnershipActor, operator: OperatorIdentity, input: {
    conversationId: string;
    expectedVersion?: number;
  }): Parameters<ConversationOwnershipRepository["takeOver"]>[0] {
    return {
      conversationId: input.conversationId,
      workspaceId: actor.workspaceId,
      accountId: actor.accountId,
      userId: operator.userId,
      displayName: operator.teammateLabel,
      expectedVersion: input.expectedVersion,
    };
  }

  private claimAudit(actor: OwnershipActor, input: {
    conversationId: string;
    reason?: string;
    auditContext?: OwnershipAuditContext;
  }): OwnershipAuditMetadata {
    return {
      action: "taken_over",
      conversationId: input.conversationId,
      ownerAccountId: actor.accountId,
      reason: input.reason,
      ...input.auditContext,
    };
  }

  private async requireConversation(actor: OwnershipActor, conversationId: string): Promise<ConversationRecord> {
    const conversation = await this.dependencies.conversations.findByIdAndWorkspaceId(conversationId, actor.workspaceId);
    if (!conversation) {
      throw notFound("Conversation not found");
    }
    return conversation;
  }

  /** After a change has committed: tells the dashboard, then audits it, neither ever failing the change. */
  private async settle(actor: OwnershipActor, result: SettledChange, metadata: OwnershipAuditMetadata): Promise<void> {
    this.announceChange(actor, result);
    await this.auditChange(actor, metadata);
  }

  private announceChange(actor: OwnershipActor, result: SettledChange): void {
    if (!result.changed) {
      return;
    }
    notifyAfterCommit(this.dependencies, {
      notification: "dashboard_refresh",
      accountId: actor.accountId,
      workspaceId: actor.workspaceId,
      conversationId: result.record.conversationId,
    }, () => {
      this.dependencies.publisher?.enqueue(actor.workspaceId, ["conversation.ownership_changed"]);
    });
  }

  private auditChange(actor: OwnershipActor, metadata: OwnershipAuditMetadata): Promise<void> {
    return recordCommittedOwnershipAudit(this.dependencies, {
      accountId: actor.accountId,
      workspaceId: actor.workspaceId,
      metadata: { ...metadata, actorUserId: actor.userId },
    });
  }
}
