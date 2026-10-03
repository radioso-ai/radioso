import type { Kysely } from "kysely";

import { EmailMailboxRepository, type MailboxPolicyChangeUnitOfWork } from "../../modules/emailChannel/public.js";
import type { DB } from "../../shared/infra/kysely/types.js";

/**
 * Binds a mailbox policy change to one Postgres transaction: the mailbox row lock, the version
 * bump and the history row commit together or not at all (research B16). S3 adds the held-reply
 * supersede scope to the same transaction.
 */
export const createPostgresMailboxPolicyChangeUnitOfWork = (deps: { db: Kysely<DB> }): MailboxPolicyChangeUnitOfWork => ({
  run: (work) => deps.db.transaction().execute((trx) => work({ mailboxes: new EmailMailboxRepository(trx) })),
});
