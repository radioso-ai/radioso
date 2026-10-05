import type { HeldReplySupersedeScope } from "../../handoff/public.js";
import type { EmailMailboxRepository } from "../persistence/emailMailboxRepository.js";

/**
 * Changes a mailbox's engagement policy as one unit: the mailbox row is locked before the
 * current version is read, the version is bumped and the history row appended, the drafts bound
 * to the old version are superseded or held for review under the new one, and any settings
 * written alongside, all in one transaction (research B1, B16). Composition binds it
 * (`mailboxPolicyChange.ts`).
 */
export interface MailboxPolicyChangeUnitOfWork {
  run<T>(work: (scope: {
    mailboxes: Pick<EmailMailboxRepository, "lockForPolicyChange" | "appendPolicyVersion" | "updateSettings">;
    heldReplies: PolicyChangeHeldReplies;
  }) => Promise<T>): Promise<T>;
}

/** What a policy change does to the drafts bound to the version it replaces, in its transaction. */
export type PolicyChangeHeldReplies = Pick<HeldReplySupersedeScope, "supersedePendingForPolicy" | "holdLiveForPolicy">;
