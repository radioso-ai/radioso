import { sendingStateOf } from "../domains/sendingState.js";
import type { EmailDomainRecord } from "../persistence/emailDomainRepository.js";
import type { EmailMailboxRecord } from "../persistence/emailMailboxRepository.js";

/** Why an operator-authorized send was halted before its first provider call (`email_send_intents.halt_reason`). */
export type SendHaltReason = "sending_not_verified" | "domain_removed" | "mailbox_removed";

type SendAuthorityVerdict = { verdict: "allow" } | { verdict: "halt"; haltReason: SendHaltReason };

interface OperatorSendAuthorityFacts {
  /** The intent's mailbox as it is now; null when it no longer exists. */
  mailbox: Pick<EmailMailboxRecord, "removedAt"> | null;
  /** The mailbox's sending domain as it is now; null when it no longer exists. */
  domain: Pick<EmailDomainRecord, "sendingStatus" | "removedAt"> | null;
}

const halt = (haltReason: SendHaltReason): SendAuthorityVerdict => ({ verdict: "halt", haltReason });

/**
 * Whether an operator-authorized send (`operator_reply`, `held_release`, `audited_resend`) may
 * still go out as the mailbox's address (research B6, FR-032). An operator authored or approved
 * the message, so only the channel's ability to send as that address is rechecked: the domain must
 * still exist and be verified for sending, and the mailbox must still exist. Engagement mode, the
 * enabled flag, ownership and the thread send budget govern automatic sends, which are authorized
 * when they materialize (research B9); an operator send renews the budget instead of spending it.
 *
 * The handler halts on a `halt` verdict before the first provider call. After an attempt with an
 * unknown outcome the same verdict only decides whether a re-POST is still authorized.
 */
export const operatorSendAuthority = (facts: OperatorSendAuthorityFacts): SendAuthorityVerdict => {
  const sending = sendingStateOf(facts.domain);
  if (sending === "domain_removed") return halt("domain_removed");
  if (!facts.mailbox || facts.mailbox.removedAt !== null) return halt("mailbox_removed");
  if (sending === "not_verified") return halt("sending_not_verified");
  return { verdict: "allow" };
};
