import { sendingStateOf, type MailboxSendingState } from "../domains/sendingState.js";
import type { EngagementMode } from "../mailboxes/effectiveMode.js";
import type { EmailDomainRepository } from "../persistence/emailDomainRepository.js";
import type { EmailMailboxRepository } from "../persistence/emailMailboxRepository.js";
import type { EmailSendIntentRepository, SendDeliveryState } from "../persistence/emailSendIntentRepository.js";
import type { EmailThreadRepository, ThreadAttachment, ThreadIndexRecord } from "../persistence/emailThreadRepository.js";
import type { SendIntentState } from "../outbound/sendIntentTransitions.js";

interface ConversationEmailMessageFacts {
  messageId: string;
  direction: "inbound" | "outbound";
  subject: string | null;
  cc: string[];
  attachments: ThreadAttachment[];
  /** The newest send intent's state and sanitized failure code; null for inbound mail. */
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

const deliveryOf = (send: SendDeliveryState | undefined): ConversationEmailMessageFacts["delivery"] =>
  send ? { state: send.state, failureCode: send.failureCode } : null;

/**
 * One entry per message, oldest first. Indexed mail comes from the thread index; a send the
 * provider never accepted (halted, refused, still queued or of unknown outcome) has no index entry
 * and comes from its send intent alone, so its failure still shows on the message (FR-037).
 */
const toMessageFacts = (
  indexed: readonly ThreadIndexRecord[],
  sends: readonly SendDeliveryState[],
): ConversationEmailMessageFacts[] => {
  const sendByMessage = new Map(sends.map((send) => [send.messageId, send]));
  const seen = new Set<string>();
  const dated: { at: number; facts: ConversationEmailMessageFacts }[] = [];
  for (const entry of indexed) {
    // A referenced id has no message; an outbound message may be indexed under two ids.
    if (entry.messageId === null || entry.direction === "referenced" || seen.has(entry.messageId)) continue;
    seen.add(entry.messageId);
    dated.push({
      at: entry.createdAt.getTime(),
      facts: {
        messageId: entry.messageId,
        direction: entry.direction,
        subject: entry.subject,
        cc: [...entry.ccAddresses],
        attachments: entry.attachments.map((attachment) => ({ ...attachment })),
        delivery: entry.direction === "outbound" ? deliveryOf(sendByMessage.get(entry.messageId)) : null,
        rawDeliveryId: entry.direction === "inbound" ? entry.inboundDeliveryId : null,
      },
    });
  }
  for (const send of sends) {
    if (seen.has(send.messageId)) continue;
    dated.push({
      at: send.createdAt.getTime(),
      facts: { messageId: send.messageId, direction: "outbound", subject: null, cc: [], attachments: [], delivery: deliveryOf(send), rawDeliveryId: null },
    });
  }
  // Stable: entries recorded at the same moment keep their index order.
  return dated.sort((left, right) => left.at - right.at).map((entry) => entry.facts);
};

/** Reads an email conversation's facts; null when the conversation is not one of the workspace's. */
export class ConversationEmailFactsReader {
  constructor(private readonly deps: {
    threads: Pick<EmailThreadRepository, "findLink" | "listIndexedMessages">;
    mailboxes: Pick<EmailMailboxRepository, "findById">;
    domains: Pick<EmailDomainRepository, "findById">;
    sends: Pick<EmailSendIntentRepository, "listDeliveryStates">;
  }) {}

  async read(workspaceId: string, conversationId: string): Promise<ConversationEmailFacts | null> {
    const link = await this.deps.threads.findLink(conversationId);
    if (!link || link.workspaceId !== workspaceId) return null;
    const mailbox = await this.deps.mailboxes.findById(link.mailboxId);
    if (!mailbox) return null;
    const [domain, indexed, sends] = await Promise.all([
      this.deps.domains.findById(mailbox.domainId),
      this.deps.threads.listIndexedMessages(conversationId),
      this.deps.sends.listDeliveryStates(conversationId),
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
      messages: toMessageFacts(indexed, sends),
    };
  }
}
