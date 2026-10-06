import { z } from "zod";

import type { CustomerReplyOutboxPort } from "../customerReplyDelivery/public.js";
import type { HeldReplyAuthorityView, HeldReplyChannelScope } from "../handoff/public.js";
import { emailSendingRefusal } from "./operator/emailSendingRefusal.js";
import { emailSendKey, enqueueEmailSendAction, type EmailSendActionPayload } from "./outbound/emailSendAction.js";
import { outboundMessageId } from "./outbound/outboundHeaders.js";
import {
  autoDispatchAuthority,
  operatorSendAuthority,
  ownershipFactsOf,
  type AutoSendVerdict,
  type EmailSendOwnershipReader,
} from "./outbound/sendAuthority.js";
import type { EmailDomainRepository } from "./persistence/emailDomainRepository.js";
import type { EmailMailboxRecord, EmailMailboxRepository } from "./persistence/emailMailboxRepository.js";
import type { EmailSendIntentRepository } from "./persistence/emailSendIntentRepository.js";
import type { EmailThreadRepository } from "./persistence/emailThreadRepository.js";

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
 * What automatic sending needs inside a held-reply transaction (research B8, B9): the thread's send
 * budget, the conversation's ownership, the send intent a materialization records, and how that
 * intent is named.
 */
interface EmailAutoSendCapability {
  threads: Pick<EmailThreadRepository, "findLink" | "reserveAutoSend">;
  ownership: EmailSendOwnershipReader;
  intents: Pick<EmailSendIntentRepository, "materialize">;
  /** The provider name intents record and provider events are correlated by. */
  provider: string;
  createId: () => string;
}

/** The review claim a review runner publishes under, as handoff hands it to the channel. */
type ReviewClaim = Parameters<HeldReplyChannelScope["authorizePublication"]>[1];

/** The refusal of a scope composed without automatic sending, as when the deployment does not run `auto`. */
const AUTO_UNSUPPORTED = { authorized: false, code: "auto_unsupported" } as const;
type AutoDispatchVerdict = AutoSendVerdict | typeof AUTO_UNSUPPORTED;

/**
 * Email's side of a held-reply transaction (research B1), bound to it by composition. It locks the
 * mailbox row against a policy change until the transaction ends — a release that locked first
 * sends under the version it read, and a policy change that committed first leaves the release a
 * newer version to be refused on — and queues a released draft's send on the transaction's outbox.
 * Handoff compares the versions; email decides whether the mailbox can still send. A review's result
 * is published only while the review runner's claim on the thread's review still holds, checked
 * under the thread's lock in the same transaction (research B17).
 *
 * Automatic sends (research B9) are queued against the thread's send budget and keyed by the held
 * reply, then authorized again and recorded as a send intent when they are materialized. The
 * capability is granted by composition only where the deployment runs `auto`; a scope without it
 * reserves nothing and authorizes no dispatch, so a queued send returns to a teammate.
 */
export class EmailHeldReplyChannelScope implements HeldReplyChannelScope {
  constructor(private readonly deps: {
    mailboxes: Pick<EmailMailboxRepository, "lockPolicy">;
    domains: Pick<EmailDomainRepository, "findById">;
    /** The review claims a held or queued result is published under. */
    reviews: Pick<EmailThreadRepository, "lockReviewClaim">;
    /** Granted where the deployment runs `auto`; absent, every automatic send is refused. */
    autoSend?: EmailAutoSendCapability;
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

  /**
   * Spends one of the thread's automatic sends against its mailbox's `thread_send_budget` (FR-022,
   * research B8); false when it is spent. The mailbox stays locked, so the limit cannot change under
   * the reservation; an operator-authorized send renews the budget, and customer mail never does.
   */
  async reserveAutoSend(conversationId: string): Promise<boolean> {
    const autoSend = this.deps.autoSend;
    if (!autoSend) return false;
    const link = await autoSend.threads.findLink(conversationId);
    const mailbox = link ? await this.deps.mailboxes.lockPolicy(link.mailboxId) : null;
    return mailbox ? autoSend.threads.reserveAutoSend(conversationId, mailbox.threadSendBudget) : false;
  }

  /**
   * Queues the held reply's automatic send on the transaction's outbox, keyed by the held reply,
   * with no message yet: it is written when the send is materialized at dispatch (research B9).
   */
  async enqueueAutoSend(heldReply: HeldReplyAuthorityView, outbox: CustomerReplyOutboxPort): Promise<void> {
    const mailbox = await this.lockedMailbox(heldReply.policyRef);
    if (!this.deps.autoSend || !mailbox) throw new Error("email_auto_send_not_queueable");
    await enqueueEmailSendAction(outbox, {
      workspaceId: mailbox.workspaceId,
      idempotencyKey: emailSendKey.heldReply(heldReply.id),
      payload: {
        version: 1,
        trigger: "auto_reply",
        mailboxId: mailbox.id,
        conversationId: heldReply.conversationId,
        messageId: null,
        heldReplyId: heldReply.id,
        authority: this.authoritySnapshot(heldReply, mailbox),
      },
    });
  }

  /**
   * Whether the queued send may still go out (FR-022, FR-032): the mailbox enabled and in `auto` at
   * the bound policy version, the conversation the AI's at the bound ownership version, the domain
   * verified for sending, and the send's reservation still inside the thread's budget as the
   * locked mailbox states it now.
   */
  async authorizeAutoDispatch(heldReply: HeldReplyAuthorityView): Promise<AutoDispatchVerdict> {
    const autoSend = this.deps.autoSend;
    if (!autoSend) return AUTO_UNSUPPORTED;
    const mailbox = await this.lockedMailbox(heldReply.policyRef);
    const [domain, ownership, link] = await Promise.all([
      mailbox ? this.deps.domains.findById(mailbox.domainId) : null,
      autoSend.ownership.load(heldReply.conversationId),
      autoSend.threads.findLink(heldReply.conversationId),
    ]);
    return autoDispatchAuthority({
      mailbox,
      domain,
      ownership: ownershipFactsOf(ownership),
      bound: { policyVersion: heldReply.policyVersion, ownershipVersion: heldReply.ownershipVersion },
      reservedAutoSends: link?.autoSendsSinceRenewal ?? null,
    });
  }

  /**
   * Records the materialized message's send intent under the held reply's key, in the transaction
   * that wrote the message, so the message carries its intent from the moment it exists (AS6.1).
   * The author is the agent; the send spends no budget here, since the publish reserved it.
   */
  async recordMaterialized(heldReply: HeldReplyAuthorityView, messageId: string): Promise<void> {
    const autoSend = this.deps.autoSend;
    const mailbox = await this.lockedMailbox(heldReply.policyRef);
    const domain = mailbox ? await this.deps.domains.findById(mailbox.domainId) : null;
    if (!autoSend || !mailbox || !domain) throw new Error("email_auto_send_not_materializable");
    const id = autoSend.createId();
    await autoSend.intents.materialize({
      id,
      workspaceId: mailbox.workspaceId,
      mailboxId: mailbox.id,
      conversationId: heldReply.conversationId,
      messageId,
      heldReplyId: heldReply.id,
      idempotencyKey: emailSendKey.heldReply(heldReply.id),
      authorKind: "agent",
      trigger: "auto_reply",
      authority: this.authoritySnapshot(heldReply, mailbox),
      provider: autoSend.provider,
      suppliedRfcMessageId: outboundMessageId(domain.domain, id),
    });
  }

  /**
   * Whether the review runner's claim still holds the thread's review, with the thread's link row
   * locked until the transaction ends: a claim another worker took over after its lease ran out,
   * or one whose review was completed since, publishes nothing (research B17).
   */
  async authorizePublication(conversationId: string, claim: ReviewClaim): Promise<boolean> {
    return this.deps.reviews.lockReviewClaim({ conversationId, attempt: claim.attempt, leaseUntil: claim.leaseUntil });
  }

  /** The authority an automatic send carries: the versions it was bound to, as the mailbox is now. */
  private authoritySnapshot(heldReply: HeldReplyAuthorityView, mailbox: EmailMailboxRecord): EmailSendActionPayload["authority"] {
    return {
      policyVersion: heldReply.policyVersion ?? mailbox.policyVersion,
      ownershipVersion: heldReply.ownershipVersion,
      mode: mailbox.engagementMode,
      domainId: mailbox.domainId,
    };
  }

  private async lockedMailbox(policyRef: string | null): Promise<EmailMailboxRecord | null> {
    const mailboxId = mailboxIdOf(policyRef);
    return mailboxId ? this.deps.mailboxes.lockPolicy(mailboxId) : null;
  }
}
