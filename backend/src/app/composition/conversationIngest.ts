import type { Kysely } from "kysely";

import { ConversationOwnershipRepository } from "../../db/repositories/conversationOwnershipRepository.js";
import { ConversationRepository } from "../../db/repositories/conversationRepository.js";
import { MessageRepository } from "../../db/repositories/messageRepository.js";
import type { ConversationIngestUnitOfWork } from "../../modules/chat/composition.js";
import type { ConversationActivityRecorder } from "../../modules/conversationActivity/contracts/index.js";
import type { DB } from "../../shared/infra/kysely/types.js";

/**
 * Runs an ingest in one Postgres transaction: the conversation, the customer's message, and a
 * handoff to a person with the activity it records all commit, or none does. Only binds the
 * repositories to that transaction; what gets written is the ingest service's decision.
 */
export const createPostgresConversationIngestUnitOfWork = (deps: {
  db: Kysely<DB>;
  activity: ConversationActivityRecorder;
}): ConversationIngestUnitOfWork => ({
  run: (work) => deps.db.transaction().execute((trx) => work({
    conversations: new ConversationRepository(trx),
    messages: new MessageRepository(trx),
    ownership: new ConversationOwnershipRepository(trx),
    activity: { record: (event) => deps.activity.record(trx, event) },
  })),
});
