import type { WorkspaceInvalidationPublisher } from "@radioso/workspace-invalidation-contract";

import type {
  ConversationOwnershipMutationResult,
  ConversationOwnershipRepository,
} from "../../db/repositories/conversationOwnershipRepository.js";
import type { ConversationRecord, ConversationRepositoryPort } from "../../db/repositories/conversationRepository.js";
import type { MessageRecord } from "../../db/repositories/messageRepository.js";
import { AppError, notFound } from "../../shared/domain/errors.js";
import type { AuditService } from "../audit/contracts/index.js";
import { recordCommittedOwnershipAudit, type CommittedAuditReporting } from "./committedOwnershipAudit.js";
import type { ConversationOperatorDirectory } from "./conversationOperatorDirectory.js";
import type { OperatorIdentity, OperatorIdentityResolver } from "./operatorIdentity.js";
import type { OperatorReply, OperatorReplyService, OperatorReplyWriteScope } from "./operatorReplyService.js";
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

/** Writes a transfer and the notice it owes as one unit: both commit, or neither does. */
export interface OwnershipTransferUnitOfWork {
  run<T>(work: (scope: {
    ownership: Pick<ConversationOwnershipRepository, "transfer">;
    outbox: TransferNoticeOutboxPort;
  }) => Promise<T>): Promise<T>;
}

/**
 * Writes a reply and the ownership it stands on as one unit: the ownership row stays locked from
 * the moment it is read until the message is written, so a transfer or hand-back either commits
 * before the reply looks (and refuses it) or waits until the reply has committed.
 */
export interface OwnershipReplyUnitOfWork {
  run<T>(work: (scope: {
    ownership: Pick<ConversationOwnershipRepository, "loadForUpdate" | "takeOver">;
    reply: OperatorReplyWriteScope;
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

/**
 * The rules for who handles a human-owned conversation, keyed on the teammate acting. Every
 * surface — the dashboard's REST routes, Slack's buttons — goes through here, so none restates
 * them:
 * - a conversation is claimed when it names a teammate (`ownerUserId`); a handoff nobody has
 *   claimed, and an AI-owned conversation, can be taken over by any teammate;
 * - only the owner replies or hands back; replying to an unclaimed or AI-owned conversation
 *   claims it for the replier first, and a reply commits with the ownership it was checked against;
 * - taking a conversation a teammate holds is an explicit transfer to yourself;
 * - a transfer and the notice it owes the recipient commit together;
 * - a committed change stands even when its audit record fails.
 */
export class ConversationOwnershipService {
  constructor(private readonly dependencies: {
    conversations: Pick<ConversationRepositoryPort, "findByIdAndWorkspaceId">;
    ownership: Pick<ConversationOwnershipRepository, "load" | "takeOver" | "handBack">;
    transfers: OwnershipTransferUnitOfWork;
    replyWrites: OwnershipReplyUnitOfWork;
    operators: Pick<ConversationOperatorDirectory, "find">;
    operatorIdentities: Pick<OperatorIdentityResolver, "resolve">;
    replies: Pick<OperatorReplyService, "write" | "deliver">;
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
    await this.requireConversation(actor, input.conversationId);
    const operator = await this.resolveOperator(actor);
    const result = await this.dependencies.ownership.takeOver(this.claimInput(actor, operator, input));
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
    const result = await this.dependencies.transfers.run(async ({ ownership, outbox }) => {
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
    const result = await this.dependencies.ownership.handBack({
      conversationId: input.conversationId,
      expectedVersion: input.expectedVersion,
      actingUserId: actor.userId,
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
   * holds is refused. `expectedVersion` omitted skips the stale-view check. The check, the claim
   * and the message commit together under the ownership row's lock; the visitor hears of the reply
   * only after it has committed.
   */
  async reply(actor: OwnershipActor, input: {
    conversationId: string;
    message: string;
    expectedVersion?: number;
    auditContext?: OwnershipAuditContext;
  }): Promise<OwnershipReplyResult> {
    const conversation = await this.requireConversation(actor, input.conversationId);
    const operator = await this.resolveOperator(actor);
    const reply: OperatorReply = { conversation, accountId: actor.accountId, operator, message: input.message };

    const outcome = await this.dependencies.replyWrites.run(async (scope): Promise<
      { ok: true; message: MessageRecord; record: ConversationOwnershipRecord; claim: SettledChange | null } | OwnershipRefused
    > => {
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
        record = claimed.record;
        claim = claimed;
      }
      const message = await this.dependencies.replies.write(scope.reply, reply);
      return { ok: true, message, record, claim };
    });
    if (!outcome.ok) {
      return outcome;
    }

    if (outcome.claim) {
      await this.settle(actor, outcome.claim, this.claimAudit(actor, input));
    }
    await this.dependencies.replies.deliver(reply, outcome.message);
    return { ok: true, message: outcome.message, record: outcome.record };
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

  /** After a change has committed: tells the dashboard, and audits it without ever failing the change. */
  private async settle(actor: OwnershipActor, result: SettledChange, metadata: OwnershipAuditMetadata): Promise<void> {
    if (result.changed) {
      this.dependencies.publisher?.enqueue(actor.workspaceId, ["conversation.ownership_changed"]);
    }
    await recordCommittedOwnershipAudit(this.dependencies, {
      accountId: actor.accountId,
      workspaceId: actor.workspaceId,
      metadata: { ...metadata, actorUserId: actor.userId },
    });
  }
}
