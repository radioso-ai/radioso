import type { Kysely } from "kysely";

import { ConversationOwnershipRepository } from "../../db/repositories/conversationOwnershipRepository.js";
import { ConversationRepository } from "../../db/repositories/conversationRepository.js";
import { HeldReplyRepository } from "../../db/repositories/heldReplyRepository.js";
import { MessageRepository } from "../../db/repositories/messageRepository.js";
import type { ConversationIngestUnitOfWork } from "../../modules/chat/composition.js";
import type { ConversationActivityRecorder } from "../../modules/conversationActivity/contracts/index.js";
import type { DB } from "../../shared/infra/kysely/types.js";

/**
 * Runs an ingest in one Postgres transaction: the conversation, the customer's message, the held
 * replies it supersedes, and a handoff to a person with the activity it records all commit, or
 * none does. Only binds the repositories to that transaction; what gets written is the ingest
 * service's decision. The drafts are superseded with the conversation's ownership row locked
 * first, the conversation lock protocol's order (`conversationLockOrder.ts`) that a takeover, which
 * holds the ownership row while it supersedes them, takes too.
 */
export const createPostgresConversationIngestUnitOfWork = (deps: {
  db: Kysely<DB>;
  activity: ConversationActivityRecorder;
}): ConversationIngestUnitOfWork => ({
  run: (work) => deps.db.transaction().execute((trx) => {
    const ownership = new ConversationOwnershipRepository(trx);
    const heldReplies = new HeldReplyRepository(trx);
    return work({
      conversations: new ConversationRepository(trx),
      messages: new MessageRepository(trx),
      ownership,
      activity: { record: (event) => deps.activity.record(trx, event) },
      heldReplies: {
        supersedePendingForConversation: async (conversationId, reason) => {
          await ownership.loadForUpdate(conversationId);
          return heldReplies.supersedePendingForConversation(conversationId, reason);
        },
      },
    });
  }),
});
