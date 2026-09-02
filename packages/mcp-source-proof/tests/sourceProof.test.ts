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
