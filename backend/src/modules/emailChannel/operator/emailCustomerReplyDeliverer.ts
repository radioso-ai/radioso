import type {
  CustomerChannelReplyDeliverer,
  CustomerReplyDeliveryConversation,
  CustomerReplyRoute,
} from "../../customerReplyDelivery/public.js";
import { emailSendKey, enqueueEmailSendAction } from "../outbound/emailSendAction.js";
import { operatorSendAuthority } from "../outbound/sendAuthority.js";
import type { EmailDomainRepository } from "../persistence/emailDomainRepository.js";
import type { EmailMailboxRepository } from "../persistence/emailMailboxRepository.js";
import { emailSendingRefusal } from "./emailSendingRefusal.js";

/**
 * Where a teammate's reply on an email conversation goes: an `email.send` action keyed by the
 * message, queued in the transaction that writes the reply (FR-031). A mailbox that cannot send as
 * its address refuses before anything is written, naming the missing step, so a reply is never
 * recorded as sent while it cannot reach the customer, and retrying after setup is safe.
 */
export class EmailCustomerReplyDeliverer implements CustomerChannelReplyDeliverer {
  constructor(private readonly deps: {
    mailboxes: Pick<EmailMailboxRepository, "findById">;
    domains: Pick<EmailDomainRepository, "findById">;
    /** The conversation's ownership version, 0 before any ownership change. */
    ownership: { versionOf(conversationId: string): Promise<number> };
  }) {}

  async route(conversation: CustomerReplyDeliveryConversation): Promise<CustomerReplyRoute | null> {
    const context = conversation.channelContext;
    if (context?.provider !== "email") return null;
    const mailbox = await this.deps.mailboxes.findById(context.mailbox.id);
    const usable = mailbox && mailbox.workspaceId === conversation.workspaceId ? mailbox : null;
    const domain = usable ? await this.deps.domains.findById(usable.domainId) : null;
    if (!usable) throw emailSendingRefusal("mailbox_removed", null);
    const verdict = operatorSendAuthority({ mailbox: usable, domain });
    if (verdict.verdict === "halt") throw emailSendingRefusal(verdict.haltReason, domain?.domain ?? null);
    const ownershipVersion = await this.deps.ownership.versionOf(conversation.id);
    return {
      enqueue: async (outbox, message) => {
        await enqueueEmailSendAction(outbox, {
          workspaceId: conversation.workspaceId,
          idempotencyKey: emailSendKey.message(message.id),
          payload: {
            version: 1,
            trigger: "operator_reply",
            mailboxId: usable.id,
            conversationId: conversation.id,
            messageId: message.id,
            heldReplyId: null,
            authority: {
              policyVersion: usable.policyVersion,
              ownershipVersion,
              mode: usable.engagementMode,
              domainId: usable.domainId,
            },
          },
        });
      },
    };
  }
}
