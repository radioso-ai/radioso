import { parseRelayAddress, splitPlusAddress } from "./relayTokens.js";

export type MailboxRoute =
  | { rule: "relay"; mailboxId: string; tokenGeneration: "current" | "previous" }
  | { rule: "direct"; mailboxId: string }
  | { rule: "direct_unknown"; workspaceId: string }
  | { rule: "relay_unknown" };

interface MailboxRouteLookups {
  inboundDomain: string;
  /** Canonical uppercase token; `previous` only while the rotation grace period lasts. */
  relayToken(token: string): { mailboxId: string; generation: "current" | "previous" } | null;
  /** A non-removed domain whose receiving status is verified. */
  receivingDomain(domain: string): { workspaceId: string } | null;
  /** Lowercase, tag-free address of an active mailbox. */
  directMailbox(address: string): { mailboxId: string } | null;
}

/**
 * Resolves one delivered-to address to a mailbox by exactly two rules (research B20): the relay
 * rule on the inbound domain, then the direct rule on a receiving-verified customer domain. Null
 * means the address is not routable, which is every customer domain without direct receiving:
 * the `To` of forwarded mail never selects a mailbox.
 */
export const routeAddress = (address: string, lookups: MailboxRouteLookups): MailboxRoute | null => {
  const parts = splitPlusAddress(address);
  if (!parts) return null;

  if (parts.domain === lookups.inboundDomain.toLowerCase()) {
    const relay = parseRelayAddress(address, lookups.inboundDomain);
    const issued = relay ? lookups.relayToken(relay.relayToken) : null;
    return issued
      ? { rule: "relay", mailboxId: issued.mailboxId, tokenGeneration: issued.generation }
      : { rule: "relay_unknown" };
  }

  const receivingDomain = lookups.receivingDomain(parts.domain);
  if (!receivingDomain) return null;
  const mailbox = lookups.directMailbox(`${parts.base.toLowerCase()}@${parts.domain}`);
  return mailbox
    ? { rule: "direct", mailboxId: mailbox.mailboxId }
    : { rule: "direct_unknown", workspaceId: receivingDomain.workspaceId };
};
