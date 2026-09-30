import type { WorkspaceInvalidationPublisher } from "@radioso/workspace-invalidation-contract";

import type {
  ConversationOwnershipMutationResult,
  ConversationOwnershipRepository,
} from "../../db/repositories/conversationOwnershipRepository.js";
import type { ConversationRepositoryPort } from "../../db/repositories/conversationRepository.js";
import type { MessageRecord } from "../../db/repositories/messageRepository.js";
import { AppError, notFound } from "../../shared/domain/errors.js";
import type { AuditService } from "../audit/contracts/index.js";
import type { ConversationOperatorDirectory } from "./conversationOperatorDirectory.js";
import type { OperatorIdentityResolver } from "./operatorIdentity.js";
import type { OperatorReplyService } from "./operatorReplyService.js";
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

type OwnershipCommandResult =
  | { ok: true; changed: boolean; record: ConversationOwnershipRecord }
  | { ok: false; refusal: OwnershipRefusal; record: ConversationOwnershipRecord | null };

type OwnershipReplyResult =
  | { ok: true; message: MessageRecord; record: ConversationOwnershipRecord }
  | { ok: false; refusal: OwnershipRefusal; record: ConversationOwnershipRecord | null };

/** Writes a transfer and the notice it owes as one unit: both commit, or neither does. */
export interface OwnershipTransferUnitOfWork {
  run<T>(work: (scope: {
    ownership: Pick<ConversationOwnershipRepository, "transfer">;
    outbox: TransferNoticeOutboxPort;
  }) => Promise<T>): Promise<T>;
}

/** Audit metadata a surface adds to the records its commands cause, e.g. the Slack user who clicked. */
type OwnershipAuditContext = Record<string, unknown>;

/** A transfer target that is not a teammate able to own conversations here; never says which. */
const transferTargetUnavailable = (): AppError =>
  new AppError(404, "transfer_target_unavailable", "Transfer target not found");

const heldByTeammate = (record: ConversationOwnershipRecord | null, userId: string): boolean =>
  record?.state === "human_owned" && record.ownerUserId !== null && record.ownerUserId !== userId;

const refusalFor = (record: ConversationOwnershipRecord | null, actor: OwnershipActor): OwnershipCommandResult => ({
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
 *   claims it for the replier first;
 * - taking a conversation a teammate holds is an explicit transfer to yourself;
 * - a transfer and the notice it owes the recipient commit together.
 */
export class ConversationOwnershipService {
  constructor(private readonly dependencies: {
    conversations: Pick<ConversationRepositoryPort, "findByIdAndWorkspaceId">;
    ownership: Pick<ConversationOwnershipRepository, "load" | "takeOver" | "handBack">;
    transfers: OwnershipTransferUnitOfWork;
    operators: Pick<ConversationOperatorDirectory, "find">;
    operatorIdentities: Pick<OperatorIdentityResolver, "resolve">;
    replies: Pick<OperatorReplyService, "reply">;
    audit: Pick<AuditService, "record">;
    publisher?: WorkspaceInvalidationPublisher;
  }) {}

  /** The conversation's ownership now; null while no teammate has ever been involved. */
  async load(conversationId: string): Promise<ConversationOwnershipRecord | null> {
    return this.dependencies.ownership.load(conversationId);
  }

  /**
   * Claims a conversation the AI owns or nobody has claimed. One a teammate holds is refused,
   * unless the caller explicitly takes it from them (`takeFromTeammate`), which transfers it to
   * the caller.
   */
  async takeOver(actor: OwnershipActor, input: {
    conversationId: string;
    reason?: string;
    takeFromTeammate?: boolean;
    auditContext?: OwnershipAuditContext;
  }): Promise<OwnershipCommandResult> {
    await this.requireConversation(actor, input.conversationId);
    const claimed = await this.claim(actor, input);
    if (!claimed.ok && input.takeFromTeammate && claimed.record?.state === "human_owned") {
      return this.transfer(actor, {
        conversationId: input.conversationId,
        toUserId: actor.userId,
        expectedVersion: claimed.record.version,
        auditContext: input.auditContext,
      });
    }
    return claimed;
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
   * holds is refused. `expectedVersion` omitted skips the stale-view check.
   */
  async reply(actor: OwnershipActor, input: {
    conversationId: string;
    message: string;
    expectedVersion?: number;
    auditContext?: OwnershipAuditContext;
  }): Promise<OwnershipReplyResult> {
    await this.requireConversation(actor, input.conversationId);
    const current = await this.dependencies.ownership.load(input.conversationId);
    if (heldByTeammate(current, actor.userId)) {
      return { ok: false, refusal: "held_by_teammate", record: current };
    }

    let record: ConversationOwnershipRecord;
    if (current?.state === "human_owned" && current.ownerUserId === actor.userId) {
      if (input.expectedVersion !== undefined && current.version !== input.expectedVersion) {
        return { ok: false, refusal: "stale", record: current };
      }
      record = current;
    } else {
      const claimed = await this.claim(actor, input);
      if (!claimed.ok) {
        return claimed;
      }
      record = claimed.record;
    }

    const message = await this.dependencies.replies.reply({
      conversationId: input.conversationId,
      workspaceId: actor.workspaceId,
      accountId: actor.accountId,
      userId: actor.userId,
      message: input.message,
    });
    return { ok: true, message, record };
  }

  private async claim(actor: OwnershipActor, input: {
    conversationId: string;
    reason?: string;
    expectedVersion?: number;
    auditContext?: OwnershipAuditContext;
  }): Promise<OwnershipCommandResult> {
    const operator = await this.dependencies.operatorIdentities.resolve({
      accountId: actor.accountId,
      userId: actor.userId,
    });
    const result = await this.dependencies.ownership.takeOver({
      conversationId: input.conversationId,
      workspaceId: actor.workspaceId,
      accountId: actor.accountId,
      userId: operator.userId,
      displayName: operator.teammateLabel,
      expectedVersion: input.expectedVersion,
    });
    if (!result.ok) {
      return refusalFor(result.record, actor);
    }
    await this.settle(actor, result, {
      action: "taken_over",
      conversationId: input.conversationId,
      ownerAccountId: actor.accountId,
      reason: input.reason,
      ...input.auditContext,
    });
    return result;
  }

  private async requireConversation(actor: OwnershipActor, conversationId: string): Promise<void> {
    const conversation = await this.dependencies.conversations.findByIdAndWorkspaceId(conversationId, actor.workspaceId);
    if (!conversation) {
      throw notFound("Conversation not found");
    }
  }

  private async settle(
    actor: OwnershipActor,
    result: Extract<ConversationOwnershipMutationResult, { ok: true }>,
    metadata: Record<string, unknown> & { action: string; conversationId: string },
  ): Promise<void> {
    if (result.changed) {
      this.dependencies.publisher?.enqueue(actor.workspaceId, ["conversation.ownership_changed"]);
    }
    await this.dependencies.audit.record({
      accountId: actor.accountId,
      workspaceId: actor.workspaceId,
      eventType: "hitl.ownership",
      eventStatus: "success",
      metadata: { ...metadata, actorUserId: actor.userId },
    });
  }
}
