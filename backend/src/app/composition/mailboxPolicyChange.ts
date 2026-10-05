import {
  createPostCommitInvalidationReceipt,
  flushPostCommitInvalidationReceipt,
  type WorkspaceInvalidationPublisher,
} from "@radioso/workspace-invalidation-contract";
import type { Kysely } from "kysely";

import { ConversationOwnershipRepository } from "../../db/repositories/conversationOwnershipRepository.js";
import { HeldReplyRepository } from "../../db/repositories/heldReplyRepository.js";
import type { ConversationActivityRecorder } from "../../modules/conversationActivity/contracts/index.js";
import { EmailMailboxRepository, type MailboxPolicyChangeUnitOfWork } from "../../modules/emailChannel/public.js";
import type { ConversationOwnershipService } from "../../modules/handoff/public.js";
import type { DB } from "../../shared/infra/kysely/types.js";

/**
 * Binds a mailbox policy change to one Postgres transaction: the mailbox row lock, the version
 * bump with its history row, the supersede (or hold for review) of the drafts bound to the old
 * version, and the hand-off of each superseded draft's conversation to a person — through the
 * ownership rules, with the activity it records — commit together or not at all (research B1,
 * B16). A release holding the mailbox row `FOR SHARE` makes the change wait until it has
 * committed. The dashboard hears of the hand-offs only once the change has committed.
 *
 * Lock order: the mailbox, then the held replies, then each handed-off conversation's ownership
 * row. A release or a review's hold locks an existing ownership row before the mailbox, so one
 * racing the change on a conversation that already has an ownership row can deadlock with it;
 * Postgres then aborts one of the two whole, and nothing of it commits.
 */
export const createPostgresMailboxPolicyChangeUnitOfWork = (deps: {
  db: Kysely<DB>;
  activity: ConversationActivityRecorder;
  ownership: Pick<ConversationOwnershipService, "requestHumanOwnership">;
  publisher?: WorkspaceInvalidationPublisher;
}): MailboxPolicyChangeUnitOfWork => ({
  async run(work) {
    const handedOffIn = new Set<string>();
    const result = await deps.db.transaction().execute((trx) => work({
      mailboxes: new EmailMailboxRepository(trx),
      heldReplies: new HeldReplyRepository(trx),
      handoffs: {
        requestHumanOwnership: async (input) => {
          const { changed } = await deps.ownership.requestHumanOwnership({
            ownership: new ConversationOwnershipRepository(trx),
            activity: { record: (event) => deps.activity.record(trx, event) },
          }, input);
          if (changed) handedOffIn.add(input.workspaceId);
          return { changed };
        },
      },
    }));
    const { publisher } = deps;
    if (publisher) {
      for (const workspaceId of handedOffIn) {
        flushPostCommitInvalidationReceipt(publisher, createPostCommitInvalidationReceipt(workspaceId, ["conversation.ownership_changed"]));
      }
    }
    return result;
  },
});
