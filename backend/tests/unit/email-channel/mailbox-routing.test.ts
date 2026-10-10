import { describe, expect, it } from "vitest";

import { routeAddress } from "../../../src/modules/emailChannel/mailboxes/mailboxRouting.js";

const INBOUND_DOMAIN = "in.relay.test";
const CURRENT_TOKEN = "QZ2K7XN4VTM3RLHJWPC6YGBSFD";
const PREVIOUS_TOKEN = "MFRGGZDFMZTWQ2LKNNWG23TPOA";
const NEVER_ISSUED_TOKEN = "ONSWG4TFORZWK3TUMVZXI2LPNY";

const relayTokens = new Map([
  [CURRENT_TOKEN, { mailboxId: "mbx-support", generation: "current" as const }],
  [PREVIOUS_TOKEN, { mailboxId: "mbx-support", generation: "previous" as const }],
]);
const receivingDomains = new Map([["receiving.customer.test", { workspaceId: "ws-1" }]]);
const directMailboxes = new Map([["care@receiving.customer.test", { mailboxId: "mbx-care" }]]);

const lookups = {
  inboundDomain: INBOUND_DOMAIN,
  relayToken: (token: string) => relayTokens.get(token) ?? null,
  receivingDomain: (domain: string) => receivingDomains.get(domain) ?? null,
  directMailbox: (address: string) => directMailboxes.get(address) ?? null,
};

describe("routeAddress", () => {
  describe("relay rule", () => {
    it("resolves the mailbox from a current relay token", () => {
      expect(routeAddress(`${CURRENT_TOKEN}@${INBOUND_DOMAIN}`, lookups)).toEqual({
        rule: "relay",
        mailboxId: "mbx-support",
        tokenGeneration: "current",
      });
    });

    it("resolves the mailbox from a previous token inside its grace period", () => {
      expect(routeAddress(`${PREVIOUS_TOKEN}@${INBOUND_DOMAIN}`, lookups)).toEqual({
        rule: "relay",
        mailboxId: "mbx-support",
        tokenGeneration: "previous",
      });
    });

    it("matches the token and domain case-insensitively and ignores a plus tag", () => {
      expect(routeAddress(`${CURRENT_TOKEN.toLowerCase()}+thrA7k2m9qzx4p@IN.RELAY.TEST`, lookups)).toEqual({
        rule: "relay",
        mailboxId: "mbx-support",
        tokenGeneration: "current",
      });
    });

    it("reports a never-issued token on the inbound domain as relay_unknown", () => {
      expect(routeAddress(`${NEVER_ISSUED_TOKEN}@${INBOUND_DOMAIN}`, lookups)).toEqual({ rule: "relay_unknown" });
    });

    it("reports a local part that is not token-shaped on the inbound domain as relay_unknown", () => {
      expect(routeAddress(`postmaster@${INBOUND_DOMAIN}`, lookups)).toEqual({ rule: "relay_unknown" });
    });

    it("checks the relay rule before the direct rule", () => {
      const inboundIsAlsoReceiving = {
        ...lookups,
        receivingDomain: () => ({ workspaceId: "ws-other" }),
        directMailbox: () => ({ mailboxId: "mbx-other" }),
      };
      expect(routeAddress(`${CURRENT_TOKEN}@${INBOUND_DOMAIN}`, inboundIsAlsoReceiving)).toEqual({
        rule: "relay",
        mailboxId: "mbx-support",
        tokenGeneration: "current",
      });
    });
  });

  describe("direct rule", () => {
    it("resolves the exact mailbox address on a receiving-verified domain", () => {
      // tests/fixtures/email-channel/mime/direct-receiving.eml
      expect(routeAddress("care@receiving.customer.test", lookups)).toEqual({ rule: "direct", mailboxId: "mbx-care" });
    });

    it("removes the plus tag and lowercases before comparing", () => {
      expect(routeAddress("Care+thrA7k2m9qzx4p@Receiving.Customer.TEST", lookups)).toEqual({
        rule: "direct",
        mailboxId: "mbx-care",
      });
    });

    it("looks the mailbox up by the tag-free lowercase address", () => {
      const seen: string[] = [];
      routeAddress("Care+tag@Receiving.Customer.Test", {
        ...lookups,
        directMailbox: (address) => {
          seen.push(address);
          return null;
        },
      });
      expect(seen).toEqual(["care@receiving.customer.test"]);
    });

    it("attributes an unknown local part on a receiving-verified domain to the domain's workspace", () => {
      expect(routeAddress("returns@receiving.customer.test", lookups)).toEqual({
        rule: "direct_unknown",
        workspaceId: "ws-1",
      });
    });
  });

  describe("unroutable addresses", () => {
    it("returns null for a customer domain without direct receiving, even when it is a mailbox address", () => {
      const seenDirect: string[] = [];
      expect(routeAddress("support@customer.test", {
        ...lookups,
        directMailbox: (address) => {
          seenDirect.push(address);
          return { mailboxId: "mbx-support" };
        },
      })).toBeNull();
      expect(seenDirect).toEqual([]);
    });

    it("returns null for a token-shaped local part off the inbound domain", () => {
      expect(routeAddress(`${CURRENT_TOKEN}@customer.test`, lookups)).toBeNull();
      expect(routeAddress(`${CURRENT_TOKEN}@sub.${INBOUND_DOMAIN}`, lookups)).toBeNull();
    });

    it("returns null for a string that is not an address", () => {
      expect(routeAddress("", lookups)).toBeNull();
      expect(routeAddress("no-at-sign", lookups)).toBeNull();
    });
  });
});
