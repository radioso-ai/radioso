import {
  routeAddress,
  type EmailDomainRepository,
  type EmailMailboxRepository,
  type MailboxRoute,
} from "../../../emailChannel/public.js";

/** One mailbox an event reached, and the rule that reached it. */
export interface MailboxTarget {
  mailboxId: string;
  rule: "relay" | "direct";
}

interface DeliveryTargets {
  mailboxes: MailboxTarget[];
  /**
   * Set when an address reached the inbound domain or a receiving domain but named no mailbox:
   * the receiving domain's workspace, or none for a relay token that was never issued.
   */
  unrouted: { workspaceId: string | null } | null;
}

export interface MailboxRouteLookups {
  inboundDomain: string;
  mailboxes: Pick<EmailMailboxRepository, "resolveRelayToken" | "findActiveByAddress">;
  domains: Pick<EmailDomainRepository, "findReceivingVerified">;
}

/**
 * Routes every delivered-to address by the two rules of research B20, through the pure
 * `routeAddress`, and groups the routes per mailbox: one processing unit each (FR-009).
 */
export const routeDeliveredTo = async (
  addresses: readonly string[],
  lookups: MailboxRouteLookups,
): Promise<DeliveryTargets> => {
  const cache = new RouteLookupCache(lookups);
  const targets = new Map<string, MailboxTarget>();
  let unrouted: DeliveryTargets["unrouted"] = null;
  for (const address of addresses) {
    const route = await cache.route(address);
    if (route === null) continue;
    if (route.rule === "relay" || route.rule === "direct") {
      if (!targets.has(route.mailboxId)) targets.set(route.mailboxId, { mailboxId: route.mailboxId, rule: route.rule });
    } else if (route.rule === "direct_unknown") {
      unrouted = { workspaceId: route.workspaceId };
    } else {
      unrouted ??= { workspaceId: null };
    }
  }
  return { mailboxes: [...targets.values()], unrouted };
};

/**
 * Answers the router's synchronous lookups from the database. A round that asks for a key not
 * yet loaded loads it and routes again, so the router stays the only place the rules live; an
 * address needs at most three rounds (relay token, or receiving domain then mailbox).
 */
class RouteLookupCache {
  private readonly relayTokens = new Map<string, { mailboxId: string; generation: "current" | "previous" } | null>();
  private readonly receivingDomains = new Map<string, { workspaceId: string } | null>();
  private readonly directMailboxes = new Map<string, { mailboxId: string } | null>();

  constructor(private readonly lookups: MailboxRouteLookups) {}

  async route(address: string): Promise<MailboxRoute | null> {
    for (;;) {
      const loads: Promise<void>[] = [];
      const route = routeAddress(address, {
        inboundDomain: this.lookups.inboundDomain,
        relayToken: (token) => read(this.relayTokens, token, loads, (key) => this.lookups.mailboxes.resolveRelayToken(key)),
        receivingDomain: (domain) =>
          read(this.receivingDomains, domain, loads, (key) => this.lookups.domains.findReceivingVerified(key)),
        directMailbox: (mailboxAddress) =>
          read(this.directMailboxes, mailboxAddress, loads, (key) => this.lookups.mailboxes.findActiveByAddress(key)),
      });
      if (loads.length === 0) return route;
      await Promise.all(loads);
    }
  }
}

const read = <T>(
  cache: Map<string, T | null>,
  key: string,
  loads: Promise<void>[],
  load: (key: string) => Promise<T | null>,
): T | null => {
  if (cache.has(key)) return cache.get(key) ?? null;
  loads.push(load(key).then((value) => {
    cache.set(key, value);
  }));
  return null;
};
