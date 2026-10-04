import type { Kysely } from "kysely";

import { HeldReplyRepository } from "../../db/repositories/heldReplyRepository.js";
import { EmailMailboxRepository, type MailboxPolicyChangeUnitOfWork } from "../../modules/emailChannel/public.js";
import type { DB } from "../../shared/infra/kysely/types.js";

/**
 * Binds a mailbox policy change to one Postgres transaction: the mailbox row lock, the version
 * bump with its history row, and the supersede of the drafts bound to the old version commit
 * together or not at all (research B1, B16). A release holding the mailbox row `FOR SHARE` makes
 * the change wait until it has committed.
 */
export const createPostgresMailboxPolicyChangeUnitOfWork = (deps: { db: Kysely<DB> }): MailboxPolicyChangeUnitOfWork => ({
  run: (work) => deps.db.transaction().execute((trx) => work({
    mailboxes: new EmailMailboxRepository(trx),
    heldReplies: new HeldReplyRepository(trx),
  })),
});
