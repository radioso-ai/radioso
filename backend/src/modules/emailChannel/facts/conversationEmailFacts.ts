import { sendingStateOf, type MailboxSendingState } from "../domains/sendingState.js";
import type { EngagementMode } from "../mailboxes/effectiveMode.js";
import type { EmailDomainRepository } from "../persistence/emailDomainRepository.js";
import type { EmailMailboxRepository } from "../persistence/emailMailboxRepository.js";
import type { EmailThreadRepository, ThreadAttachment, ThreadIndexRecord } from "../persistence/emailThreadRepository.js";

type SendIntentState = "queued" | "accepted" | "delivered" | "bounced" | "failed" | "uncertain" | "halted";

interface ConversationEmailMessageFacts {
  messageId: string;
  direction: "inbound" | "outbound";
  subject: string | null;
  cc: string[];
  attachments: ThreadAttachment[];
  /** The send intent's state; null for inbound mail, and for every message until sending ships (S2). */
  delivery: { state: SendIntentState; failureCode: string | null } | null;
  /** The delivery holding the raw message, for an inbound message. */
  rawDeliveryId: string | null;
}

/** The inbox header and per-message facts of an email conversation (FR-012, research B13). */
export interface ConversationEmailFacts {
  mailbox: { id: string; address: string; displayName: string; engagementMode: EngagementMode };
  participant: { address: string; displayName: string | null };
  latest: { subject: string | null; cc: string[]; inboundAt: string | null };
  sending: { state: MailboxSendingState };
  sendBudget: { used: number; limit: number; renewedAt: string | null };
  messages: ConversationEmailMessageFacts[];
}

const toMessageFacts = (indexed: readonly ThreadIndexRecord[]): ConversationEmailMessageFacts[] => {
  const seen = new Set<string>();
  const messages: ConversationEmailMessageFacts[] = [];
  for (const entry of indexed) {
    // A referenced id has no message; an outbound message may be indexed under two ids.
    if (entry.messageId === null || entry.direction === "referenced" || seen.has(entry.messageId)) continue;
    seen.add(entry.messageId);
    messages.push({
      messageId: entry.messageId,
      direction: entry.direction,
      subject: entry.subject,
      cc: [...entry.ccAddresses],
      attachments: entry.attachments.map((attachment) => ({ ...attachment })),
      delivery: null,
      rawDeliveryId: entry.direction === "inbound" ? entry.inboundDeliveryId : null,
    });
  }
  return messages;
};

/** Reads an email conversation's facts; null when the conversation is not one of the workspace's. */
export class ConversationEmailFactsReader {
  constructor(private readonly deps: {
    threads: Pick<EmailThreadRepository, "findLink" | "listIndexedMessages">;
    mailboxes: Pick<EmailMailboxRepository, "findById">;
    domains: Pick<EmailDomainRepository, "findById">;
  }) {}

  async read(workspaceId: string, conversationId: string): Promise<ConversationEmailFacts | null> {
    const link = await this.deps.threads.findLink(conversationId);
    if (!link || link.workspaceId !== workspaceId) return null;
    const mailbox = await this.deps.mailboxes.findById(link.mailboxId);
    if (!mailbox) return null;
    const [domain, indexed] = await Promise.all([
      this.deps.domains.findById(mailbox.domainId),
      this.deps.threads.listIndexedMessages(conversationId),
    ]);
    return {
      mailbox: { id: mailbox.id, address: mailbox.address, displayName: mailbox.displayName, engagementMode: mailbox.engagementMode },
      participant: { address: link.participantAddress, displayName: link.latestParticipantDisplayName },
      latest: { subject: link.latestSubject, cc: [...link.latestCcAddresses], inboundAt: link.latestInboundAt?.toISOString() ?? null },
      sending: { state: sendingStateOf(domain) },
      sendBudget: {
        used: link.autoSendsSinceRenewal,
        limit: mailbox.threadSendBudget,
        renewedAt: link.budgetRenewedAt?.toISOString() ?? null,
      },
      messages: toMessageFacts(indexed),
    };
  }
}
