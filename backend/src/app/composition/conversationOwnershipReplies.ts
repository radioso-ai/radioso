import type { Kysely } from "kysely";

import { ConversationOwnershipRepository } from "../../db/repositories/conversationOwnershipRepository.js";
import { ConversationRepository } from "../../db/repositories/conversationRepository.js";
import { MessageRepository } from "../../db/repositories/messageRepository.js";
import type { OwnershipReplyUnitOfWork } from "../../modules/handoff/public.js";
import type { DB } from "../../shared/infra/kysely/types.js";

/**
 * Runs a teammate's reply in one Postgres transaction: the ownership row is read `FOR UPDATE`, so
 * a transfer or hand-back cannot commit between the ownership check and the message insert, and a
 * claim made by the reply rolls back with a message that fails to write.
 */
export const createPostgresOwnershipReplyUnitOfWork = (deps: { db: Kysely<DB> }): OwnershipReplyUnitOfWork => ({
  run: (work) => deps.db.transaction().execute((trx) => work({
    ownership: new ConversationOwnershipRepository(trx),
    reply: {
      messages: new MessageRepository(trx),
      conversations: new ConversationRepository(trx),
    },
  })),
});
