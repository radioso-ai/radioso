import type { EmailDomainRecord } from "../persistence/emailDomainRepository.js";

export type MailboxSendingState = "ok" | "not_verified" | "domain_removed";

/** Whether mail can go out as the mailbox's address: its domain must be active and verified. */
export const sendingStateOf = (domain: Pick<EmailDomainRecord, "sendingStatus" | "removedAt"> | null): MailboxSendingState => {
  if (!domain || domain.removedAt !== null) return "domain_removed";
  return domain.sendingStatus === "verified" ? "ok" : "not_verified";
};
