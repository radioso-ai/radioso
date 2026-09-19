import { describe, expect, it } from "vitest";

import {
  resolveTrustedForwardedAddress,
  signEnvelope,
  verifyEnvelope,
} from "../src/index.js";

const context = "radioso:edge-proof-tests:v1";
const secret = "0123456789abcdef0123456789abcdef";
const payload = "D0GJ62ZQvM0QF23UXwB8Y6v6nTS26zrXbA_oYopE07g";
const now = new Date("2026-09-01T12:00:00.000Z");

describe("generic HMAC envelope", () => {
  it("verifies a freshly signed envelope", () => {
    const proof = signEnvelope({
      context,
      method: "POST",
      path: "/api/v1/example",
      secret,
      payload,
      now,
    });

    expect(verifyEnvelope({
      ...proof,
      context,
      method: "POST",
      path: "/api/v1/example",
      secret,
      payload,
      now,
    })).toBe(true);
  });

  it("rejects a stale timestamp outside the default 60s window", () => {
    const proof = signEnvelope({
      context,
      method: "POST",
      path: "/api/v1/example",
      secret,
      payload,
      now,
    });

    expect(verifyEnvelope({
      ...proof,
      context,
      method: "POST",
      path: "/api/v1/example",
      secret,
      payload,
      now: new Date(now.getTime() + 61_000),
    })).toBe(false);
  });

  it("accepts a widened window when maxAgeMs is supplied", () => {
    const proof = signEnvelope({
      context,
      method: "POST",
      path: "/api/v1/example",
      secret,
      payload,
      now,
    });

    expect(verifyEnvelope({
      ...proof,
      context,
      method: "POST",
      path: "/api/v1/example",
      secret,
      payload,
      now: new Date(now.getTime() + 61_000),
      maxAgeMs: 120_000,
    })).toBe(true);
  });

  it("rejects a tampered signature", () => {
    const proof = signEnvelope({
      context,
      method: "POST",
      path: "/api/v1/example",
      secret,
      payload,
      now,
    });

    expect(verifyEnvelope({
      ...proof,
      signature: `${proof.signature.slice(0, -1)}x`,
      context,
      method: "POST",
      path: "/api/v1/example",
      secret,
      payload,
      now,
    })).toBe(false);
  });

  it("is domain-separated: a proof for one context does not verify under another", () => {
    const proof = signEnvelope({
      context,
      method: "POST",
      path: "/api/v1/example",
      secret,
      payload,
      now,
    });

    expect(verifyEnvelope({
      ...proof,
      context: "radioso:other-context:v1",
      method: "POST",
      path: "/api/v1/example",
      secret,
      payload,
      now,
    })).toBe(false);
  });

  it("binds the signature to method, path, and payload", () => {
    const proof = signEnvelope({
      context,
      method: "POST",
      path: "/api/v1/example",
      secret,
      payload,
      now,
    });

    expect(verifyEnvelope({
      ...proof, context, method: "GET", path: "/api/v1/example", secret, payload, now,
    })).toBe(false);
    expect(verifyEnvelope({
      ...proof, context, method: "POST", path: "/api/v1/other", secret, payload, now,
    })).toBe(false);
    expect(verifyEnvelope({
      ...proof, context, method: "POST", path: "/api/v1/example", secret, payload: "different-payload", now,
    })).toBe(false);
  });
});

describe("resolveTrustedForwardedAddress", () => {
  it("selects the documented trusted client suffix and ignores spoofed prefixes", () => {
    const first = resolveTrustedForwardedAddress({
      forwardedFor: "198.51.100.99, 203.0.113.7, 35.191.0.1",
      socketAddress: "169.254.1.1",
      trustedProxyHops: 2,
    });
    const second = resolveTrustedForwardedAddress({
      forwardedFor: "192.0.2.44, 203.0.113.7, 35.191.0.1",
      socketAddress: "169.254.1.1",
      trustedProxyHops: 2,
    });

    expect(first).toBe("203.0.113.7");
    expect(second).toBe("203.0.113.7");
  });

  it("falls back to the socket peer for missing or malformed trusted suffixes", () => {
    expect(resolveTrustedForwardedAddress({ socketAddress: "169.254.1.1", trustedProxyHops: 2 })).toBe("169.254.1.1");
    expect(resolveTrustedForwardedAddress({
      forwardedFor: "203.0.113.7, not-an-ip",
      socketAddress: "169.254.1.1",
      trustedProxyHops: 2,
    })).toBe("169.254.1.1");
    expect(resolveTrustedForwardedAddress({
      forwardedFor: "203.0.113.7",
      socketAddress: "169.254.1.1",
      trustedProxyHops: 2,
    })).toBe("169.254.1.1");
  });

  it("ignores forwarded headers by default (hops <= 0) for self-hosted deployments", () => {
    expect(resolveTrustedForwardedAddress({
      forwardedFor: "203.0.113.7, 35.191.0.1",
      socketAddress: "169.254.1.1",
    })).toBe("169.254.1.1");
  });

  it("returns null when there is no socket address to fall back to", () => {
    expect(resolveTrustedForwardedAddress({ trustedProxyHops: 2 })).toBeNull();
    expect(resolveTrustedForwardedAddress({})).toBeNull();
  });
});
