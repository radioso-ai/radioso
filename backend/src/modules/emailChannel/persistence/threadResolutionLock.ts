import { createHash } from "node:crypto";

import { transactionAdvisoryLock } from "../../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../../shared/infra/kysely/types.js";

/**
 * The lock key for resolving one participant's threads in one mailbox. The participant address
 * is hashed so the key carries no personal data into lock diagnostics.
 */
export const threadResolutionLockKey = (input: { mailboxId: string; participantAddress: string }): string => {
  const participant = createHash("sha256").update(input.participantAddress.trim().toLowerCase()).digest("hex");
  return `email_thread:${input.mailboxId}:${participant}`;
};

/**
 * Serializes thread resolution and reservation for one mailbox and participant until the
 * transaction ends (research B15 step 1). Both members of an out-of-order pair take the same key,
 * because continuing a thread requires the same participant, so the second always sees the
 * first's committed reservation. Outside a transaction the lock would release at once, so that
 * is refused.
 */
export const lockThreadResolution = async (
  db: Db,
  input: { mailboxId: string; participantAddress: string },
): Promise<void> => {
  if (!db.isTransaction) {
    throw new Error("The thread-resolution lock must be taken inside a transaction");
  }
  await transactionAdvisoryLock(threadResolutionLockKey(input)).execute(db);
};
