import { z } from "zod";

import type { CustomerReplyOutboxPort } from "../customerReplyDelivery/public.js";
import type { HeldReplyAuthorityView, HeldReplyChannelScope } from "../handoff/public.js";
import { emailSendingRefusal } from "./operator/emailSendingRefusal.js";
import { emailSendKey, enqueueEmailSendAction } from "./outbound/emailSendAction.js";
import { operatorSendAuthority } from "./outbound/sendAuthority.js";
import type { EmailDomainRepository } from "./persistence/emailDomainRepository.js";
import type { EmailMailboxRecord, EmailMailboxRepository } from "./persistence/emailMailboxRepository.js";

/** The prefix of the policy refs email binds its drafts to; composition registers email's scope under it. */
export const EMAIL_MAILBOX_POLICY_REF_PREFIX = "email_mailbox:";

/** The policy ref a mailbox's drafts are bound to: its engagement policy, `email_mailbox:<mailboxId>`. */
export const emailMailboxPolicyRef = (mailboxId: string): string => `${EMAIL_MAILBOX_POLICY_REF_PREFIX}${mailboxId}`;

const MAILBOX_ID = z.string().uuid();

/** The mailbox a policy ref names; null when the ref is not a mailbox's. */
const mailboxIdOf = (policyRef: string | null): string | null => {
  if (!policyRef?.startsWith(EMAIL_MAILBOX_POLICY_REF_PREFIX)) return null;
  const parsed = MAILBOX_ID.safeParse(policyRef.slice(EMAIL_MAILBOX_POLICY_REF_PREFIX.length));
  return parsed.success ? parsed.data : null;
};

/**
 * Email's side of a held-reply transaction (research B1), bound to it by composition. It locks the
 * mailbox row against a policy change until the transaction ends — a release that locked first
 * sends under the version it read, and a policy change that committed first leaves the release a
 * newer version to be refused on — and queues a released draft's send on the transaction's outbox.
 * Handoff compares the versions; email decides whether the mailbox can still send.
 */
export class EmailHeldReplyChannelScope implements HeldReplyChannelScope {
  constructor(private readonly deps: {
    mailboxes: Pick<EmailMailboxRepository, "lockPolicy">;
    domains: Pick<EmailDomainRepository, "findById">;
  }) {}

  /** The mailbox's policy version, locked; null when the ref names no active mailbox. */
  async lockPolicy(policyRef: string): Promise<{ version: number } | null> {
    const mailbox = await this.lockedMailbox(policyRef);
    return mailbox ? { version: mailbox.policyVersion } : null;
  }

  /**
   * Queues the released message as a `held_release` send under the authority the release was
   * checked against, keyed by the message so it goes out once. A mailbox that can no longer send as
   * its address refuses with `409 email_sending_not_verified`, naming the missing step, and the
   * release rolls back with it.
   */
  async enqueueRelease(heldReply: HeldReplyAuthorityView, messageId: string, outbox: CustomerReplyOutboxPort): Promise<void> {
    const mailbox = await this.lockedMailbox(heldReply.policyRef);
    if (!mailbox) throw emailSendingRefusal("mailbox_removed", null);
    const domain = await this.deps.domains.findById(mailbox.domainId);
    const verdict = operatorSendAuthority({ mailbox, domain });
    if (verdict.verdict === "halt") throw emailSendingRefusal(verdict.haltReason, domain?.domain ?? null);
    await enqueueEmailSendAction(outbox, {
      workspaceId: mailbox.workspaceId,
      idempotencyKey: emailSendKey.message(messageId),
      payload: {
        version: 1,
        trigger: "held_release",
        mailboxId: mailbox.id,
        conversationId: heldReply.conversationId,
        messageId,
        heldReplyId: heldReply.id,
        authority: {
          policyVersion: mailbox.policyVersion,
          ownershipVersion: heldReply.ownershipVersion,
          mode: mailbox.engagementMode,
          domainId: mailbox.domainId,
        },
      },
    });
  }

  private async lockedMailbox(policyRef: string | null): Promise<EmailMailboxRecord | null> {
    const mailboxId = mailboxIdOf(policyRef);
    return mailboxId ? this.deps.mailboxes.lockPolicy(mailboxId) : null;
  }
}
