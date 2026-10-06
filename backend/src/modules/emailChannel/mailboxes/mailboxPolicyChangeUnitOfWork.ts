import type { HeldReplySupersedeScope } from "../../handoff/public.js";
import type { EmailMailboxRepository } from "../persistence/emailMailboxRepository.js";

/**
 * Changes a mailbox's engagement policy as one unit: the conversations whose live drafts it may
 * settle are locked first, then the mailbox row before the current version is read, the version is
 * bumped and the history row appended, the drafts bound to the old version are superseded or held
 * for review under the new one, the conversations whose draft was superseded are handed to a
 * person, and any settings written alongside, all in one transaction (research B1, B16). A
 * mailbox's removal is one too. Composition binds it (`mailboxPolicyChange.ts`).
 */
export interface MailboxPolicyChangeUnitOfWork {
  run<T>(work: (scope: {
    conversations: PolicyChangeConversationLocks;
    mailboxes: Pick<EmailMailboxRepository, "lockForPolicyChange" | "appendPolicyVersion" | "updateSettings" | "markRemoved">;
    heldReplies: PolicyChangeHeldReplies;
    handoffs: PolicyChangeHandoffs;
  }) => Promise<T>): Promise<T>;
}

/**
 * The conversations a change to a mailbox may settle drafts on, locked before the mailbox in the
 * conversation lock protocol's order: each conversation with a live draft bound to the policy, then
 * its ownership row. A release on one of them locks it before the mailbox too, so the two queue on
 * the conversation instead of each holding what the other waits for.
 */
export interface PolicyChangeConversationLocks {
  lockWithLiveDrafts(input: { workspaceId: string; policyRef: string }): Promise<void>;
}

/** What a policy change does to the drafts bound to the version it replaces, in its transaction. */
export type PolicyChangeHeldReplies = Pick<HeldReplySupersedeScope, "supersedePendingForPolicy" | "holdLiveForPolicy">;

/** Why a policy change hands a conversation to a person: see `handoffReasonAfter` in `mailboxService.ts`. */
export type PolicyChangeHandoffReason = "operator_only_mailbox" | "policy_changed";

/**
 * Hands a conversation whose draft a policy change superseded to a person, unclaimed, in the
 * change's transaction and through the ownership rules: one a person already owns is left as it is.
 */
export interface PolicyChangeHandoffs {
  requestHumanOwnership(input: { workspaceId: string; conversationId: string; reason: PolicyChangeHandoffReason }): Promise<{ changed: boolean }>;
}
