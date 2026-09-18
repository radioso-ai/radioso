import { describe, expect, it } from "vitest";

import {
  canonicalizeEdgeRequestFacts,
  createEdgeFactsProof,
  EDGE_FACTS_HEADERS,
  verifyEdgeFactsProof,
  type EdgeRequestFacts,
} from "../src/index.js";

const secret = "0123456789abcdef0123456789abcdef";
const now = new Date("2026-09-01T12:00:00.000Z");

const facts: EdgeRequestFacts = {
  clientIp: "203.0.113.7",
  geoHeaders: { "cf-ipcountry": "NL" },
  userAgent: "Mozilla/5.0 (Test)",
  acceptLanguage: "de-DE,de;q=0.9",
};

describe("createEdgeFactsProof / verifyEdgeFactsProof round trip", () => {
  it("verifies a freshly created proof and returns the facts", () => {
    const { headers } = createEdgeFactsProof({
      facts,
      method: "POST",
      path: "/api/public/chat/token123",
      secret,
      now,
    });

    const result = verifyEdgeFactsProof({
      headers,
      method: "POST",
      path: "/api/public/chat/token123",
      secret,
      now,
    });

    expect(result).toEqual({ ok: true, facts });
  });

  it("rejects a tampered facts payload with reason 'signature'", () => {
    const { headers } = createEdgeFactsProof({
      facts,
      method: "POST",
      path: "/api/public/chat/token123",
      secret,
      now,
    });

    const tamperedFacts = Buffer.from(JSON.stringify({ ...facts, clientIp: "198.51.100.1" }), "utf8")
      .toString("base64url");

    const result = verifyEdgeFactsProof({
      headers: { ...headers, [EDGE_FACTS_HEADERS.facts]: tamperedFacts },
      method: "POST",
      path: "/api/public/chat/token123",
      secret,
      now,
    });

    expect(result).toEqual({ ok: false, reason: "signature" });
  });

  it("rejects a proof outside the clock-skew window with reason 'expired'", () => {
    const { headers } = createEdgeFactsProof({
      facts,
      method: "POST",
      path: "/api/public/chat/token123",
      secret,
      now,
    });

    const result = verifyEdgeFactsProof({
      headers,
      method: "POST",
      path: "/api/public/chat/token123",
      secret,
      now: new Date(now.getTime() + 61_000),
    });

    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("reports 'missing' when a required header is absent", () => {
    const { headers } = createEdgeFactsProof({
      facts,
      method: "POST",
      path: "/api/public/chat/token123",
      secret,
      now,
    });
    const { [EDGE_FACTS_HEADERS.signature]: _dropped, ...withoutSignature } = headers;

    const result = verifyEdgeFactsProof({
      headers: withoutSignature,
      method: "POST",
      path: "/api/public/chat/token123",
      secret,
      now,
    });

    expect(result).toEqual({ ok: false, reason: "missing" });
  });

  it("reports 'malformed' for invalid base64/JSON in the facts header", () => {
    const { headers } = createEdgeFactsProof({
      facts,
      method: "POST",
      path: "/api/public/chat/token123",
      secret,
      now,
    });

    const result = verifyEdgeFactsProof({
      headers: { ...headers, [EDGE_FACTS_HEADERS.facts]: "not-valid-json-!!!" },
      method: "POST",
      path: "/api/public/chat/token123",
      secret,
      now,
    });

    expect(result).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("canonicalizeEdgeRequestFacts", () => {
  it("is independent of geoHeaders key order and case", () => {
    const a = canonicalizeEdgeRequestFacts({
      clientIp: "203.0.113.7",
      geoHeaders: { "CF-IPCountry": "NL", "X-Client-Region": "Europe" },
      userAgent: "UA",
      acceptLanguage: "en",
    });
    const b = canonicalizeEdgeRequestFacts({
      clientIp: "203.0.113.7",
      geoHeaders: { "x-client-region": "Europe", "cf-ipcountry": "NL" },
      userAgent: "UA",
      acceptLanguage: "en",
    });

    expect(a).toBe(b);
  });

  it("caps userAgent at 512 chars and acceptLanguage at 256 chars before signing", () => {
    const longUserAgent = "U".repeat(600);
    const longAcceptLanguage = "L".repeat(300);

    const canonical = canonicalizeEdgeRequestFacts({
      clientIp: null,
      geoHeaders: {},
      userAgent: longUserAgent,
      acceptLanguage: longAcceptLanguage,
    });
    const parsed = JSON.parse(canonical) as { userAgent: string; acceptLanguage: string };

    expect(parsed.userAgent).toHaveLength(512);
    expect(parsed.acceptLanguage).toHaveLength(256);
    expect(longUserAgent.startsWith(parsed.userAgent)).toBe(true);
    expect(longAcceptLanguage.startsWith(parsed.acceptLanguage)).toBe(true);
  });

  it("also caps the facts carried in the proof header, not just the signed payload", () => {
    const longUserAgent = "U".repeat(600);

    const { headers } = createEdgeFactsProof({
      facts: { clientIp: null, geoHeaders: {}, userAgent: longUserAgent, acceptLanguage: null },
      method: "GET",
      path: "/x",
      secret,
      now,
    });

    const result = verifyEdgeFactsProof({ headers, method: "GET", path: "/x", secret, now });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.facts.userAgent).toHaveLength(512);
    }
  });
});
