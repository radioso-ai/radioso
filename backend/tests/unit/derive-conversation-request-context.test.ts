import { createEdgeFactsProof, EDGE_FACTS_HEADERS } from "@radioso/edge-proof";
import { describe, expect, it } from "vitest";

import { deriveConversationRequestContext } from "../../src/shared/domain/conversationRequestContext.js";
import { HeaderVisitorGeoResolver } from "../../src/shared/domain/visitorGeoResolver.js";

const SECRET = "a".repeat(32);
const METHOD = "POST";
const PATH = "/api/v1/public/chat/token123";
const NOW = new Date("2026-09-18T00:00:00.000Z");

const geoResolver = new HeaderVisitorGeoResolver();

describe("deriveConversationRequestContext (FR-023)", () => {
  it("resolves edge_proof facts from a valid signed proof, with clientIp null when this backend trusts zero hops", () => {
    const { headers: proofHeaders } = createEdgeFactsProof({
      facts: {
        forwardedFor: "203.0.113.9",
        geoHeaders: { "cf-ipcountry": "nl" },
        userAgent: "TestAgent/1.0",
        acceptLanguage: "nl-NL,nl;q=0.9",
      },
      method: METHOD,
      path: PATH,
      secret: SECRET,
      now: NOW,
    });

    const result = deriveConversationRequestContext({
      headers: { [EDGE_FACTS_HEADERS.marker]: "frontend", ...proofHeaders },
      socketAddress: "10.0.0.1",
      trustedProxyHops: 0,
      secret: SECRET,
      method: METHOD,
      path: PATH,
      geoResolver,
      now: NOW,
    });

    expect(result.rejection).toBeUndefined();
    expect(result.context).toEqual({
      clientIp: null,
      country: "NL",
      region: null,
      city: null,
      userAgent: "TestAgent/1.0",
      acceptLanguage: "nl-NL,nl;q=0.9",
      observedVia: "edge_proof",
    });
  });

  it("resolves clientIp from the envelope's forwarded-for chain using this backend's own trusted hop count", () => {
    const { headers: proofHeaders } = createEdgeFactsProof({
      facts: {
        forwardedFor: "203.0.113.9, 10.0.0.4",
        geoHeaders: {},
        userAgent: null,
        acceptLanguage: null,
      },
      method: METHOD,
      path: PATH,
      secret: SECRET,
      now: NOW,
    });

    const result = deriveConversationRequestContext({
      headers: { [EDGE_FACTS_HEADERS.marker]: "frontend", ...proofHeaders },
      socketAddress: "10.0.0.1",
      trustedProxyHops: 1,
      secret: SECRET,
      method: METHOD,
      path: PATH,
      geoResolver,
      now: NOW,
    });

    expect(result.context.clientIp).toBe("10.0.0.4");
    expect(result.context.observedVia).toBe("edge_proof");
  });

  it("nulls every fact and reports 'signature' when the proof is tampered", () => {
    const { headers: proofHeaders } = createEdgeFactsProof({
      facts: { forwardedFor: "203.0.113.9", geoHeaders: {}, userAgent: null, acceptLanguage: null },
      method: METHOD,
      path: PATH,
      secret: SECRET,
      now: NOW,
    });

    const result = deriveConversationRequestContext({
      headers: { [EDGE_FACTS_HEADERS.marker]: "frontend", ...proofHeaders, [EDGE_FACTS_HEADERS.signature]: "tampered-signature-value-thats-wrong" },
      socketAddress: "10.0.0.1",
      trustedProxyHops: 0,
      secret: SECRET,
      method: METHOD,
      path: PATH,
      geoResolver,
      now: NOW,
    });

    expect(result.rejection).toBe("signature");
    expect(result.context).toEqual({
      clientIp: null,
      country: null,
      region: null,
      city: null,
      userAgent: null,
      acceptLanguage: null,
      observedVia: "unproven",
    });
  });

  it("reports 'expired' when the proof is outside the freshness window", () => {
    const { headers: proofHeaders } = createEdgeFactsProof({
      facts: { forwardedFor: "203.0.113.9", geoHeaders: {}, userAgent: null, acceptLanguage: null },
      method: METHOD,
      path: PATH,
      secret: SECRET,
      now: new Date(NOW.getTime() - 10 * 60 * 1000),
    });

    const result = deriveConversationRequestContext({
      headers: { [EDGE_FACTS_HEADERS.marker]: "frontend", ...proofHeaders },
      socketAddress: "10.0.0.1",
      trustedProxyHops: 0,
      secret: SECRET,
      method: METHOD,
      path: PATH,
      geoResolver,
      now: NOW,
    });

    expect(result.rejection).toBe("expired");
    expect(result.context.observedVia).toBe("unproven");
  });

  it("reports 'malformed' when the facts header does not decode", () => {
    const result = deriveConversationRequestContext({
      headers: {
        [EDGE_FACTS_HEADERS.marker]: "frontend",
        [EDGE_FACTS_HEADERS.facts]: "not-base64url-json",
        [EDGE_FACTS_HEADERS.signature]: "some-signature",
        [EDGE_FACTS_HEADERS.timestamp]: String(Math.floor(NOW.getTime() / 1000)),
      },
      socketAddress: "10.0.0.1",
      trustedProxyHops: 0,
      secret: SECRET,
      method: METHOD,
      path: PATH,
      geoResolver,
      now: NOW,
    });

    expect(result.rejection).toBe("malformed");
    expect(result.context.observedVia).toBe("unproven");
  });

  it("reports 'missing' when the marker is present but proof headers are absent", () => {
    const result = deriveConversationRequestContext({
      headers: { [EDGE_FACTS_HEADERS.marker]: "frontend" },
      socketAddress: "10.0.0.1",
      trustedProxyHops: 0,
      secret: SECRET,
      method: METHOD,
      path: PATH,
      geoResolver,
      now: NOW,
    });

    expect(result.rejection).toBe("missing");
    expect(result.context.observedVia).toBe("unproven");
  });

  it("reports 'missing' when the marker is present but no secret is configured on this backend", () => {
    const { headers: proofHeaders } = createEdgeFactsProof({
      facts: { forwardedFor: "203.0.113.9", geoHeaders: {}, userAgent: null, acceptLanguage: null },
      method: METHOD,
      path: PATH,
      secret: SECRET,
      now: NOW,
    });

    const result = deriveConversationRequestContext({
      headers: { [EDGE_FACTS_HEADERS.marker]: "frontend", ...proofHeaders },
      socketAddress: "10.0.0.1",
      trustedProxyHops: 0,
      secret: undefined,
      method: METHOD,
      path: PATH,
      geoResolver,
      now: NOW,
    });

    expect(result.rejection).toBe("missing");
    expect(result.context.observedVia).toBe("unproven");
  });

  it("derives backend-observed facts from the socket/headers when there is no marker", () => {
    const result = deriveConversationRequestContext({
      headers: {
        "x-forwarded-for": "203.0.113.5, 10.0.0.9",
        "cf-ipcountry": "de",
        "user-agent": "Mozilla/5.0",
        "accept-language": "de-DE,de;q=0.9",
      },
      socketAddress: "10.0.0.9",
      trustedProxyHops: 1,
      secret: SECRET,
      method: "GET",
      path: "/api/v1/agents/agent1/chat",
      geoResolver,
      now: NOW,
    });

    expect(result.rejection).toBeUndefined();
    expect(result.context).toEqual({
      clientIp: "10.0.0.9",
      country: "DE",
      region: null,
      city: null,
      userAgent: "Mozilla/5.0",
      acceptLanguage: "de-DE,de;q=0.9",
      observedVia: "backend",
    });
  });

  it("caps userAgent and acceptLanguage at their contract limits", () => {
    const result = deriveConversationRequestContext({
      headers: {
        "user-agent": "a".repeat(600),
        "accept-language": "b".repeat(300),
      },
      socketAddress: "10.0.0.9",
      trustedProxyHops: 0,
      secret: SECRET,
      method: "GET",
      path: "/api/v1/agents/agent1/chat",
      geoResolver,
      now: NOW,
    });

    expect(result.context.userAgent).toHaveLength(512);
    expect(result.context.acceptLanguage).toHaveLength(256);
  });
});
