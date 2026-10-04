import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createMcpSourceProof,
  digestSourceAddress,
  resolveSourceDigest,
  verifyMcpSourceProof,
} from "../src/index.js";

const secret = "0123456789abcdef0123456789abcdef";
const sourceDigest = "D0GJ62ZQvM0QF23UXwB8Y6v6nTS26zrXbA_oYopE07g";
const now = new Date("2026-09-01T12:00:00.000Z");

describe("MCP internal source proof", () => {
  it("verifies a fresh source digest using a domain-separated proof", () => {
    const proof = createMcpSourceProof({
      method: "POST",
      path: "/api/v1/mcp/converse/session/validate",
      secret,
      sourceDigest,
      now,
    });

    expect(verifyMcpSourceProof({
      ...proof,
      method: "POST",
      path: "/api/v1/mcp/converse/session/validate",
      secret,
      now,
    })).toBe(sourceDigest);
  });

  it("rejects stale, tampered, and route-replayed proof values", () => {
    const proof = createMcpSourceProof({
      method: "POST",
      path: "/api/v1/mcp/converse/ask",
      secret,
      sourceDigest,
      now,
    });

    expect(verifyMcpSourceProof({
      ...proof,
      method: "POST",
      path: "/api/v1/mcp/converse/ask",
      secret,
      now: new Date(now.getTime() + 61_000),
    })).toBeNull();
    expect(verifyMcpSourceProof({
      ...proof,
      signature: `${proof.signature.slice(0, -1)}x`,
      method: "POST",
      path: "/api/v1/mcp/converse/ask",
      secret,
      now,
    })).toBeNull();
    expect(verifyMcpSourceProof({
      ...proof,
      method: "POST",
      path: "/api/v1/mcp/converse/session/validate",
      secret,
      now,
    })).toBeNull();
  });
});

describe("trusted proxy source resolution", () => {
  it("selects the documented trusted client suffix and ignores spoofed prefixes", () => {
    const first = resolveSourceDigest({
      forwardedFor: "198.51.100.99, 203.0.113.7, 35.191.0.1",
      socketAddress: "169.254.1.1",
      trustedProxyHops: 2,
    });
    const second = resolveSourceDigest({
      forwardedFor: "192.0.2.44, 203.0.113.7, 35.191.0.1",
      socketAddress: "169.254.1.1",
      trustedProxyHops: 2,
    });

    expect(first).toBe(digestSourceAddress("203.0.113.7"));
    expect(second).toBe(first);
  });

  it("keeps two real clients distinct behind one shared socket peer", () => {
    const first = resolveSourceDigest({
      forwardedFor: "203.0.113.7, 35.191.0.1",
      socketAddress: "169.254.1.1",
      trustedProxyHops: 2,
    });
    const second = resolveSourceDigest({
      forwardedFor: "203.0.113.8, 35.191.0.1",
      socketAddress: "169.254.1.1",
      trustedProxyHops: 2,
    });

    expect(first).not.toBe(second);
  });

  it("falls back to the socket peer for missing or malformed trusted suffixes", () => {
    const fallback = digestSourceAddress("169.254.1.1");
    expect(resolveSourceDigest({ socketAddress: "169.254.1.1", trustedProxyHops: 2 })).toBe(fallback);
    expect(resolveSourceDigest({
      forwardedFor: "203.0.113.7, not-an-ip",
      socketAddress: "169.254.1.1",
      trustedProxyHops: 2,
    })).toBe(fallback);
    expect(resolveSourceDigest({
      forwardedFor: "203.0.113.7",
      socketAddress: "169.254.1.1",
      trustedProxyHops: 2,
    })).toBe(fallback);
  });

  it("ignores forwarded headers by default for self-hosted deployments", () => {
    expect(resolveSourceDigest({
      forwardedFor: "203.0.113.7, 35.191.0.1",
      socketAddress: "169.254.1.1",
    })).toBe(digestSourceAddress("169.254.1.1"));
  });
});

describe("source budget keys", () => {
  const legacyDigest = (value: string) =>
    createHmac("sha256", "radioso:source-address:v1").update(value).digest("base64url");

  it("keeps an IPv4 address and non-address input on the exact digest they always had", () => {
    expect(digestSourceAddress("203.0.113.7")).toBe(legacyDigest("203.0.113.7"));
    expect(digestSourceAddress("unknown")).toBe(legacyDigest("unknown"));
  });

  it("gives every address in one IPv6 /64 the same digest, however it is written", () => {
    const first = digestSourceAddress("2001:db8:1:2::1");

    expect(digestSourceAddress("2001:db8:1:2:ffff:ffff:ffff:ffff")).toBe(first);
    expect(digestSourceAddress("2001:0DB8:0001:0002:0000:0000:0000:0042")).toBe(first);
    expect(digestSourceAddress("2001:db8:1:2:a:b:1.2.3.4")).toBe(first);
  });

  it("gives different IPv6 /64 networks different digests", () => {
    expect(digestSourceAddress("2001:db8:1:3::1")).not.toBe(digestSourceAddress("2001:db8:1:2::1"));
    expect(digestSourceAddress("2001:db9:1:2::1")).not.toBe(digestSourceAddress("2001:db8:1:2::1"));
  });

  it("keys an IPv4-mapped IPv6 address on the IPv4 address it carries", () => {
    const ipv4 = digestSourceAddress("203.0.113.7");

    expect(digestSourceAddress("::ffff:203.0.113.7")).toBe(ipv4);
    expect(digestSourceAddress("::FFFF:203.0.113.7")).toBe(ipv4);
    expect(digestSourceAddress("::ffff:cb00:7107")).toBe(ipv4);
    expect(digestSourceAddress("::ffff:203.0.113.8")).not.toBe(ipv4);
  });

  it("resolves two forwarded clients in one IPv6 /64 to one budget", () => {
    const first = resolveSourceDigest({ forwardedFor: "198.51.100.99, 2001:db8:1:2::1", trustedProxyHops: 1 });
    const second = resolveSourceDigest({ forwardedFor: "2001:db8:1:2::abcd", trustedProxyHops: 1 });
    const elsewhere = resolveSourceDigest({ forwardedFor: "2001:db8:1:3::1", trustedProxyHops: 1 });

    expect(second).toBe(first);
    expect(elsewhere).not.toBe(first);
  });
});
