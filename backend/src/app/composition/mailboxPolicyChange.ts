import {
  createPostCommitInvalidationReceipt,
  flushPostCommitInvalidationReceipt,
  type WorkspaceInvalidationKind,
  type WorkspaceInvalidationPublisher,
} from "@radioso/workspace-invalidation-contract";
import type { Kysely } from "kysely";

import { ConversationOwnershipRepository } from "../../db/repositories/conversationOwnershipRepository.js";
import { HeldReplyRepository } from "../../db/repositories/heldReplyRepository.js";
import type { ConversationActivityRecorder } from "../../modules/conversationActivity/contracts/index.js";
import { EmailMailboxRepository, type MailboxPolicyChangeUnitOfWork } from "../../modules/emailChannel/public.js";
import type { ConversationOwnershipService } from "../../modules/handoff/public.js";
import type { DB } from "../../shared/infra/kysely/types.js";
import { lockConversationsInOrder, runTransactionWithDeadlockRetry } from "./conversationLockOrder.js";

/**
 * Binds a mailbox policy change, or a mailbox's removal, to one Postgres transaction: the locks on
 * the conversations of the mailbox's live drafts, the mailbox row lock, the version bump with its
 * history row, the supersede (or hold for review) of the drafts bound to the old version, and the
 * hand-off of each superseded draft's conversation to a person — through the ownership rules, with
 * the activity it records — commit together or not at all (research B1, B16).
 *
 * The locks follow the conversation lock protocol (`conversationLockOrder.ts`): each live draft's
 * conversation and ownership row before the mailbox, so a release, which holds them before it locks
 * the mailbox `FOR SHARE`, queues behind the change or the change behind it, and neither holds what
 * the other waits for. Only a draft born after the change locked its conversations can still meet a
 * release out of order; a deadlock victim's whole transaction runs again, a bounded number of times.
 *
 * The dashboard hears once the change has committed: of the drafts it superseded, of the ones it
 * returned to or re-bound for a teammate, and of the hand-offs.
 */
export const createPostgresMailboxPolicyChangeUnitOfWork = (deps: {
  db: Kysely<DB>;
  activity: ConversationActivityRecorder;
  ownership: Pick<ConversationOwnershipService, "requestHumanOwnership">;
  publisher?: WorkspaceInvalidationPublisher;
  /** Where a deadlock victim's retry is logged, by unit and attempt. */
  logger?: { warn(fields: Record<string, unknown>, message: string): void };
}): MailboxPolicyChangeUnitOfWork => ({
  async run(work) {
    // What committed, by workspace; reset with each attempt, since an aborted one committed nothing.
    let notices = new Map<string, Set<WorkspaceInvalidationKind>>();
    const notice = (workspaceId: string | null, kind: WorkspaceInvalidationKind): void => {
      if (workspaceId === null) return;
      const kinds = notices.get(workspaceId) ?? new Set<WorkspaceInvalidationKind>();
      notices.set(workspaceId, kinds.add(kind));
    };
    const result = await runTransactionWithDeadlockRetry(deps.db, (trx) => {
      notices = new Map();
      const heldReplies = new HeldReplyRepository(trx);
      // The workspace of the change, named when it locks its conversations.
      let workspaceId: string | null = null;
      return work({
        conversations: {
          lockWithLiveDrafts: async (input) => {
            workspaceId = input.workspaceId;
            await lockConversationsInOrder(trx, input.workspaceId, await heldReplies.liveConversationIds(input.policyRef));
          },
        },
        mailboxes: new EmailMailboxRepository(trx),
        heldReplies: {
          supersedePendingForPolicy: async (policyRef, reason) => {
            const superseded = await heldReplies.supersedePendingForPolicy(policyRef, reason);
            if (superseded.length > 0) notice(workspaceId, "hitl.decision_resolved");
            return superseded;
          },
          holdLiveForPolicy: async (policyRef, policyVersion, reason) => {
            const held = await heldReplies.holdLiveForPolicy(policyRef, policyVersion, reason);
            if (held.returned + held.rebound > 0) notice(workspaceId, "hitl.decision_created");
            return held;
          },
        },
        handoffs: {
          requestHumanOwnership: async (input) => {
            const { changed } = await deps.ownership.requestHumanOwnership({
              ownership: new ConversationOwnershipRepository(trx),
              activity: { record: (event) => deps.activity.record(trx, event) },
            }, input);
            if (changed) notice(input.workspaceId, "conversation.ownership_changed");
            return { changed };
          },
        },
      });
    }, { unit: "mailbox_policy_change", logger: deps.logger });
    const { publisher } = deps;
    if (publisher) {
      for (const [workspaceId, kinds] of notices) {
        flushPostCommitInvalidationReceipt(publisher, createPostCommitInvalidationReceipt(workspaceId, [...kinds]));
      }
    }
    return result;
  },
});
