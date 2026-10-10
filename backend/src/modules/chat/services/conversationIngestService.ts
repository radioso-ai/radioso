import {
  createPostCommitInvalidationReceipt,
  flushPostCommitInvalidationReceipt,
  type WorkspaceInvalidationKind,
  type WorkspaceInvalidationPublisher,
} from "@radioso/workspace-invalidation-contract";

import type { ConversationOwnershipRepository } from "../../../db/repositories/conversationOwnershipRepository.js";
import type { ConversationRepository } from "../../../db/repositories/conversationRepository.js";
import type { MessageRepositoryPort } from "../../../db/repositories/messageRepository.js";
import { AppError, notFound } from "../../../shared/domain/errors.js";
import type {
  ConversationOwnershipRecord,
  ConversationOwnershipService,
  HeldReplySupersedeScope,
  HumanOwnershipRequestScope,
} from "../../handoff/public.js";
import type {
  ConversationIngestInput,
  ConversationIngestPort,
  ConversationIngestResult,
} from "../contracts/conversationIngest.js";

/** The writes one ingest makes, bound to a single transaction by composition. */
export interface ConversationIngestScope extends HumanOwnershipRequestScope {
  conversations: Pick<ConversationRepository, "createIfAbsent" | "lockForUpdate" | "touch">;
  messages: Pick<MessageRepositoryPort, "findByIdAndWorkspaceId" | "create">;
  ownership: Pick<ConversationOwnershipRepository, "requestHandoff" | "loadForUpdate">;
  heldReplies: Pick<HeldReplySupersedeScope, "supersedePendingForConversation">;
}

/** Runs an ingest's writes as one unit: all commit, or none does. */
export interface ConversationIngestUnitOfWork {
  run<T>(work: (scope: ConversationIngestScope) => Promise<T>): Promise<T>;
}

interface CommittedIngest {
  conversationCreated: boolean;
  messageCreated: boolean;
  supersededHeldReplies: number;
  ownership: ConversationOwnershipRecord | null;
  ownershipChanged: boolean;
}

const messageIdConflict = (): AppError =>
  new AppError(409, "message_id_conflict", "Message id is already in use");

const conversationIdConflict = (): AppError =>
  new AppError(409, "conversation_id_conflict", "Conversation id is already in use");

/**
 * Records a customer's message without running a turn, for a channel that decides later whether
 * one runs. The conversation (when new), the message, the drafts it makes stale and any handoff to
 * a person commit together under the conversation's row lock; the caller's ids make a retry record
 * nothing twice. It runs no turn and reserves no usage — it has no collaborator that could. The
 * dashboard hears of it only once it has committed.
 */
export class ConversationIngestService implements ConversationIngestPort {
  constructor(private readonly dependencies: {
    unitOfWork: ConversationIngestUnitOfWork;
    ownership: Pick<ConversationOwnershipService, "requestHumanOwnership">;
    publisher?: WorkspaceInvalidationPublisher;
  }) {}

  async ingest(input: ConversationIngestInput): Promise<ConversationIngestResult> {
    const committed = await this.dependencies.unitOfWork.run(async (scope): Promise<CommittedIngest> => {
      const conversationCreated = await this.openConversation(scope, input);
      const messageCreated = await this.recordMessage(scope, input);
      // A draft answers the customer's newest message; one they wrote after it makes the draft stale.
      const supersededHeldReplies = messageCreated && !conversationCreated
        ? await scope.heldReplies.supersedePendingForConversation(input.conversation.conversationId, "newer_inbound")
        : 0;
      const { record, changed } = await this.settleOwnership(scope, input);
      return { conversationCreated, messageCreated, supersededHeldReplies, ownership: record, ownershipChanged: changed };
    });
    this.announce(input.workspaceId, committed);
    return {
      conversationId: input.conversation.conversationId,
      messageId: input.message.id,
      conversationCreated: committed.conversationCreated,
      messageCreated: committed.messageCreated,
      ownership: committed.ownership
        ? { state: committed.ownership.state, version: committed.ownership.version }
        : { state: "ai_owned", version: 0 },
    };
  }

  /**
   * Creates a new conversation unless it exists, then locks it — the lock every writer of the
   * conversation takes first, so this message dates after theirs and retries of it serialize.
   */
  private async openConversation(scope: ConversationIngestScope, input: ConversationIngestInput): Promise<boolean> {
    const { conversation, workspaceId } = input;
    const created = conversation.kind === "new"
      ? await scope.conversations.createIfAbsent({
          id: conversation.conversationId,
          workspaceId,
          agentId: input.agentId,
          sourceChannel: conversation.sourceChannel,
          channelContext: conversation.channelContext,
        })
      : false;
    if (!(await scope.conversations.lockForUpdate(conversation.conversationId, workspaceId))) {
      throw conversation.kind === "new" ? conversationIdConflict() : notFound("Conversation not found");
    }
    return created;
  }

  /** Writes the message unless a retry already did; safe because the conversation is locked. */
  private async recordMessage(scope: ConversationIngestScope, input: ConversationIngestInput): Promise<boolean> {
    const { conversation, message, workspaceId } = input;
    const existing = await scope.messages.findByIdAndWorkspaceId(workspaceId, message.id);
    if (existing) {
      if (existing.conversationId !== conversation.conversationId) {
        throw messageIdConflict();
      }
      return false;
    }
    await scope.messages.create({
      id: message.id,
      conversationId: conversation.conversationId,
      workspaceId,
      role: "user",
      source: "customer",
      content: message.text,
      metadata: { receivedAt: message.receivedAt.toISOString() },
    });
    await scope.conversations.touch(conversation.conversationId, workspaceId);
    return true;
  }

  private async settleOwnership(scope: ConversationIngestScope, input: ConversationIngestInput): Promise<{
    record: ConversationOwnershipRecord | null;
    changed: boolean;
  }> {
    const conversationId = input.conversation.conversationId;
    if (!input.humanOwnership) {
      return { record: await scope.ownership.loadForUpdate(conversationId), changed: false };
    }
    return this.dependencies.ownership.requestHumanOwnership(scope, {
      conversationId,
      workspaceId: input.workspaceId,
      reason: input.humanOwnership.reason,
    });
  }

  private announce(workspaceId: string, committed: CommittedIngest): void {
    if (!this.dependencies.publisher) {
      return;
    }
    const changeKinds: WorkspaceInvalidationKind[] = [];
    if (committed.conversationCreated) {
      changeKinds.push("conversation.created");
    }
    if (committed.messageCreated) {
      changeKinds.push("conversation.turn_committed");
    }
    if (committed.supersededHeldReplies > 0) {
      changeKinds.push("hitl.decision_resolved");
    }
    if (committed.ownershipChanged) {
      changeKinds.push("conversation.ownership_changed");
    }
    flushPostCommitInvalidationReceipt(
      this.dependencies.publisher,
      createPostCommitInvalidationReceipt(workspaceId, changeKinds),
    );
  }
}
