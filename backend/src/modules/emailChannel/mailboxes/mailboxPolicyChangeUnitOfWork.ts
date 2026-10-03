import type { EmailMailboxRepository } from "../persistence/emailMailboxRepository.js";

/**
 * Changes a mailbox's engagement policy as one unit: the mailbox row is locked before the
 * current version is read, the version is bumped and the history row appended, and any settings
 * written alongside, all in one transaction. Composition binds it (`mailboxPolicyChange.ts`);
 * the held-reply supersede scope joins it when drafts exist (S3).
 */
export interface MailboxPolicyChangeUnitOfWork {
  run<T>(work: (scope: {
    mailboxes: Pick<EmailMailboxRepository, "lockForPolicyChange" | "appendPolicyVersion" | "updateSettings">;
  }) => Promise<T>): Promise<T>;
}
