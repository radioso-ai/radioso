import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  generateOpaqueToken,
  parsePlusToken,
  parseRelayAddress,
  splitPlusAddress,
} from "../../../src/modules/emailChannel/mailboxes/relayTokens.js";

const INBOUND_DOMAIN = "in.relay.test";
// The relay token the fixture corpus forwards to (tests/fixtures/email-channel/README.md).
const FIXTURE_RELAY_TOKEN = "QZ2K7XN4VTM3RLHJWPC6YGBSFD";
const BASE32 = /^[A-Z2-7]{26}$/;

const fixedBytes = (byte: number) => (size: number) => new Uint8Array(size).fill(byte);

describe("generateOpaqueToken", () => {
  it("is 26 characters of RFC 4648 base32", () => {
    for (let i = 0; i < 50; i += 1) {
      expect(generateOpaqueToken(randomBytes)).toMatch(BASE32);
    }
  });

  it("draws at least 128 bits from the byte source", () => {
    const requested: number[] = [];
    generateOpaqueToken((size) => {
      requested.push(size);
      return randomBytes(size);
    });

    expect(requested).toHaveLength(1);
    expect(requested[0] * 8).toBeGreaterThanOrEqual(128);
  });

  it("encodes every drawn bit, so distinct bytes give distinct tokens", () => {
    expect(generateOpaqueToken(fixedBytes(0x00))).toBe("A".repeat(26));
    // 128 one-bits: 25 full groups of 11111, then 111 padded with 00.
    expect(generateOpaqueToken(fixedBytes(0xff))).toBe(`${"7".repeat(25)}4`);
    expect(generateOpaqueToken((size) => {
      const bytes = new Uint8Array(size);
      bytes[0] = 0xff;
      return bytes;
    })).toBe(`74${"A".repeat(24)}`);
  });

  it("does not repeat across draws from a real random source", () => {
    const tokens = new Set(Array.from({ length: 1_000 }, () => generateOpaqueToken(randomBytes)));
    expect(tokens.size).toBe(1_000);
  });

  it("refuses a byte source that returns fewer than 128 bits", () => {
    expect(() => generateOpaqueToken(() => new Uint8Array(15))).toThrow();
  });
});

describe("splitPlusAddress", () => {
  it("separates the base local part, the plus tag and the lowercase domain", () => {
    expect(splitPlusAddress("Support+thrA7k2m9qzx4p@Customer.TEST")).toEqual({
      base: "Support",
      tag: "thrA7k2m9qzx4p",
      domain: "customer.test",
    });
    expect(splitPlusAddress("support@customer.test")).toEqual({
      base: "support",
      tag: null,
      domain: "customer.test",
    });
  });

  it("splits on the first plus only", () => {
    expect(splitPlusAddress("support+a+b@customer.test")).toEqual({
      base: "support",
      tag: "a+b",
      domain: "customer.test",
    });
  });

  it("rejects strings that are not a single bare address", () => {
    for (const value of ["", "support", "@customer.test", "support@", "support@@customer.test", "a b@customer.test", "+tag@customer.test"]) {
      expect(splitPlusAddress(value)).toBeNull();
    }
  });
});

describe("parseRelayAddress", () => {
  it("reads the relay token from an address on the inbound domain", () => {
    expect(parseRelayAddress(`${FIXTURE_RELAY_TOKEN}@${INBOUND_DOMAIN}`, INBOUND_DOMAIN)).toEqual({
      relayToken: FIXTURE_RELAY_TOKEN,
      plusTag: null,
    });
  });

  it("treats the token and the domain case-insensitively and returns the canonical uppercase token", () => {
    expect(parseRelayAddress(`${FIXTURE_RELAY_TOKEN.toLowerCase()}@IN.Relay.Test`, "In.Relay.TEST")).toEqual({
      relayToken: FIXTURE_RELAY_TOKEN,
      plusTag: null,
    });
  });

  it("keeps a plus tag on the relay address apart from the relay token", () => {
    expect(parseRelayAddress(`${FIXTURE_RELAY_TOKEN}+thrA7k2m9qzx4p@${INBOUND_DOMAIN}`, INBOUND_DOMAIN)).toEqual({
      relayToken: FIXTURE_RELAY_TOKEN,
      plusTag: "thrA7k2m9qzx4p",
    });
  });

  it("never parses a customer-domain address as a relay address, even with a token-shaped local part", () => {
    for (const address of [
      "support@customer.test",
      `${FIXTURE_RELAY_TOKEN}@customer.test`,
      `${FIXTURE_RELAY_TOKEN}@sub.${INBOUND_DOMAIN}`,
      `${FIXTURE_RELAY_TOKEN}@${INBOUND_DOMAIN}.customer.test`,
      `${FIXTURE_RELAY_TOKEN}@relay.test`,
    ]) {
      expect(parseRelayAddress(address, INBOUND_DOMAIN)).toBeNull();
    }
  });

  it("does not read a malformed local part on the inbound domain as a token", () => {
    for (const local of ["postmaster", FIXTURE_RELAY_TOKEN.slice(1), `${FIXTURE_RELAY_TOKEN}A`, `${FIXTURE_RELAY_TOKEN.slice(1)}0`]) {
      expect(parseRelayAddress(`${local}@${INBOUND_DOMAIN}`, INBOUND_DOMAIN)).toBeNull();
    }
  });
});

describe("parsePlusToken", () => {
  it("returns the plus tag verbatim from a plus-addressed mailbox address", () => {
    // tests/fixtures/email-channel/mime/token-only-reply.eml delivers to this address.
    expect(parsePlusToken("support+thrA7k2m9qzx4p@customer.test")).toBe("thrA7k2m9qzx4p");
  });

  it("returns null when the address carries no tag", () => {
    expect(parsePlusToken("support@customer.test")).toBeNull();
    expect(parsePlusToken("support+@customer.test")).toBeNull();
    expect(parsePlusToken("not an address")).toBeNull();
  });
});
