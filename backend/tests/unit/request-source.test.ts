import { createEdgeFactsProof, EDGE_FACTS_HEADERS } from "@radioso/edge-proof";
import { digestSourceAddress } from "@radioso/mcp-source-proof";
import express, { type Request, type Response } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import {
  createRequestSourceMiddleware,
  readPublishedEdgeFactsEnvelope,
  readRequestSource,
} from "../../src/app/http/middleware/requestSource.js";
import { readEdgeFactsEnvelope } from "../../src/shared/domain/edgeFactsEnvelope.js";
import { resolveRequestSourceAddress } from "../../src/shared/domain/requestSource.js";
import { MetricsRegistry } from "../../src/shared/observability/metrics/metricsRegistry.js";

const SECRET = "a".repeat(32);
const METHOD = "POST";
const PATH = "/api/v1/public/chat/token123/sessions";
const NOW = new Date("2026-09-28T00:00:00.000Z");

const CLIENT = "203.0.113.9";
const FORGED = "198.51.100.99";
const FRONTEND_EGRESS = "34.96.0.5";
const SOCKET = "169.254.1.1";

// Hosted Cloud Run: its front end appends exactly the connecting peer, on
// run.app and on mapped domains alike, so the backend trusts one hop.
const HOSTED_HOPS = 1;

const signedEnvelope = (
  forwardedFor: string | null,
  options: { secret?: string; method?: string; path?: string; now?: Date } = {},
) => ({
  [EDGE_FACTS_HEADERS.marker]: "frontend",
  ...createEdgeFactsProof({
    facts: { forwardedFor, geoHeaders: {}, userAgent: null, acceptLanguage: null },
    method: options.method ?? METHOD,
    path: options.path ?? PATH,
    secret: options.secret ?? SECRET,
    now: options.now ?? NOW,
  }).headers,
});

const resolve = (input: {
  headers?: Record<string, string>;
  trustedProxyHops: number;
  secret?: string;
}) => {
  const headers = input.headers ?? {};
  return resolveRequestSourceAddress({
    headers,
    socketAddress: SOCKET,
    trustedProxyHops: input.trustedProxyHops,
    envelope: readEdgeFactsEnvelope({ headers, secret: input.secret, method: METHOD, path: PATH, now: NOW }),
  });
};

describe("resolveRequestSourceAddress", () => {
  describe("the backend's own observation", () => {
    it("ignores X-Forwarded-For entirely at zero trusted hops", () => {
      expect(resolve({ headers: { "x-forwarded-for": CLIENT }, trustedProxyHops: 0 })).toBe(SOCKET);
    });

    it("takes the entry Cloud Run appended, never a caller-supplied prefix", () => {
      expect(resolve({
        headers: { "x-forwarded-for": `${FORGED}, ${CLIENT}` },
        trustedProxyHops: HOSTED_HOPS,
      })).toBe(CLIENT);
    });

    it("falls back to the socket when the chain is shorter than the trusted hop count", () => {
      expect(resolve({ headers: { "x-forwarded-for": CLIENT }, trustedProxyHops: 2 })).toBe(SOCKET);
    });

    it("falls back to the socket when the trusted suffix holds a non-address entry", () => {
      expect(resolve({
        headers: { "x-forwarded-for": `${CLIENT}, not-an-address` },
        trustedProxyHops: HOSTED_HOPS,
      })).toBe(SOCKET);
    });
  });

  describe("a frontend edge-facts envelope", () => {
    it("resolves the chain the frontend received, not the longer chain the backend received", () => {
      expect(resolve({
        headers: {
          ...signedEnvelope(CLIENT),
          "x-forwarded-for": `${CLIENT}, ${FRONTEND_EGRESS}`,
        },
        trustedProxyHops: HOSTED_HOPS,
        secret: SECRET,
      })).toBe(CLIENT);
    });

    it("takes the trusted suffix of a verified chain, never the spoofed prefix the visitor sent the frontend", () => {
      expect(resolve({
        headers: {
          ...signedEnvelope(`${FORGED}, ${CLIENT}`),
          "x-forwarded-for": `${FORGED}, ${CLIENT}, ${FRONTEND_EGRESS}`,
        },
        trustedProxyHops: HOSTED_HOPS,
        secret: SECRET,
      })).toBe(CLIENT);
    });

    it("falls back to the backend's own observation when a verified envelope yields no address", () => {
      expect(resolve({
        headers: {
          ...signedEnvelope(null),
          "x-forwarded-for": CLIENT,
        },
        trustedProxyHops: HOSTED_HOPS,
        secret: SECRET,
      })).toBe(CLIENT);
    });

    it("ignores an envelope signed for a different path and keeps the backend's own observation", () => {
      expect(resolve({
        headers: {
          ...signedEnvelope(FORGED, { path: "/api/v1/auth/password-reset/confirm" }),
          "x-forwarded-for": CLIENT,
        },
        trustedProxyHops: HOSTED_HOPS,
        secret: SECRET,
      })).toBe(CLIENT);
    });

    it("ignores an envelope signed for a different method and keeps the backend's own observation", () => {
      expect(resolve({
        headers: {
          ...signedEnvelope(FORGED, { method: "GET" }),
          "x-forwarded-for": CLIENT,
        },
        trustedProxyHops: HOSTED_HOPS,
        secret: SECRET,
      })).toBe(CLIENT);
    });

    it("ignores an envelope that fails verification and keeps the backend's own observation", () => {
      expect(resolve({
        headers: {
          ...signedEnvelope(FORGED, { secret: "b".repeat(32) }),
          "x-forwarded-for": CLIENT,
        },
        trustedProxyHops: HOSTED_HOPS,
        secret: SECRET,
      })).toBe(CLIENT);
    });

    it("ignores a marker with no proof and keeps the backend's own observation", () => {
      expect(resolve({
        headers: {
          [EDGE_FACTS_HEADERS.marker]: "frontend",
          "x-forwarded-for": CLIENT,
        },
        trustedProxyHops: HOSTED_HOPS,
        secret: SECRET,
      })).toBe(CLIENT);
    });

    it("never trusts an envelope when this backend has no edge-proof secret", () => {
      expect(resolve({
        headers: {
          ...signedEnvelope(FORGED),
          "x-forwarded-for": CLIENT,
        },
        trustedProxyHops: HOSTED_HOPS,
      })).toBe(CLIENT);
    });
  });

  it("returns null when there is neither a trusted chain nor a socket address", () => {
    expect(resolveRequestSourceAddress({
      headers: {},
      socketAddress: null,
      trustedProxyHops: HOSTED_HOPS,
      envelope: { status: "absent" },
    })).toBeNull();
  });
});

describe("readRequestSource", () => {
  it("falls back to the socket peer, never X-Forwarded-For, when the app-level middleware did not run", () => {
    const req = {
      headers: { "x-forwarded-for": `${FORGED}, ${CLIENT}` },
      socket: { remoteAddress: SOCKET },
    } as unknown as Request;
    const res = { locals: {} } as unknown as Response;

    expect(readRequestSource(req, res)).toEqual({ address: SOCKET, digest: digestSourceAddress(SOCKET) });
    expect(readPublishedEdgeFactsEnvelope(res)).toBeUndefined();
  });
});

describe("createRequestSourceMiddleware", () => {
  const createEchoApp = (metricsRegistry: MetricsRegistry, options: { secret: string | undefined } = { secret: SECRET }) => {
    const app = express();
    app.use(createRequestSourceMiddleware({
      env: { RADIOSO_TRUSTED_PROXY_HOPS: HOSTED_HOPS, RADIOSO_EDGE_PROOF_SECRET: options.secret },
      metricsRegistry,
    }));
    app.post(PATH, (req, res) => {
      res.status(200).json({
        source: readRequestSource(req, res),
        envelopeStatus: readPublishedEdgeFactsEnvelope(res)?.status ?? null,
      });
    });
    return app;
  };

  it("counts an edge marker that fails to prove itself by reason, and keeps budgeting on the backend's own observation", async () => {
    const metricsRegistry = new MetricsRegistry();
    const app = createEchoApp(metricsRegistry);
    const tampered = {
      ...signedEnvelope(FORGED, { now: new Date() }),
      [EDGE_FACTS_HEADERS.signature]: "tampered-signature-value-thats-wrong",
    };

    const tamperedResponse = await request(app)
      .post(PATH)
      .set(tampered)
      .set("X-Forwarded-For", CLIENT)
      .expect(200);
    await request(app)
      .post(PATH)
      .set(EDGE_FACTS_HEADERS.marker, "frontend")
      .set("X-Forwarded-For", CLIENT)
      .expect(200);

    expect(tamperedResponse.body).toEqual({
      source: { address: CLIENT, digest: digestSourceAddress(CLIENT) },
      envelopeStatus: "rejected",
    });
    const rendered = metricsRegistry.renderPrometheus();
    expect(rendered).toContain('radioso_edge_facts_proof_rejected_total{reason="signature"} 1');
    expect(rendered).toContain('radioso_edge_facts_proof_rejected_total{reason="missing"} 1');
    expect(rendered).not.toContain(CLIENT);
    expect(rendered).not.toContain(FORGED);
  });

  it("leaves the rejection counter alone for a verified envelope and for a request with no edge marker", async () => {
    const metricsRegistry = new MetricsRegistry();
    const app = createEchoApp(metricsRegistry);

    const verifiedResponse = await request(app)
      .post(PATH)
      .set(signedEnvelope(CLIENT, { now: new Date() }))
      .set("X-Forwarded-For", `${CLIENT}, ${FRONTEND_EGRESS}`)
      .expect(200);
    const directResponse = await request(app)
      .post(PATH)
      .set("X-Forwarded-For", `${FORGED}, ${CLIENT}`)
      .expect(200);

    expect(verifiedResponse.body).toEqual({
      source: { address: CLIENT, digest: digestSourceAddress(CLIENT) },
      envelopeStatus: "verified",
    });
    expect(directResponse.body).toEqual({
      source: { address: CLIENT, digest: digestSourceAddress(CLIENT) },
      envelopeStatus: "absent",
    });
    expect(metricsRegistry.renderPrometheus()).not.toContain("edge_facts_proof_rejected_total");
  });

  it("leaves the counter alone when this backend has no edge-proof secret, since the proof path never runs", async () => {
    const metricsRegistry = new MetricsRegistry();
    const app = createEchoApp(metricsRegistry, { secret: undefined });

    const response = await request(app)
      .post(PATH)
      .set(signedEnvelope(FORGED, { now: new Date() }))
      .set("X-Forwarded-For", `${CLIENT}, ${FRONTEND_EGRESS}`)
      .expect(200);

    expect(response.body).toEqual({
      source: { address: FRONTEND_EGRESS, digest: digestSourceAddress(FRONTEND_EGRESS) },
      envelopeStatus: "rejected",
    });
    expect(metricsRegistry.renderPrometheus()).not.toContain("edge_facts_proof_rejected_total");
  });

  it("publishes the full IPv6 address for audit while keying the budget on its /64", async () => {
    const app = createEchoApp(new MetricsRegistry());
    const client = "2001:db8:1:2:aaaa:bbbb:cccc:dddd";

    const { body } = await request(app)
      .post(PATH)
      .set("X-Forwarded-For", client)
      .expect(200) as { body: { source: { address: string; digest: string } } };

    expect(body.source.address).toBe(client);
    expect(body.source.digest).toBe(digestSourceAddress("2001:db8:1:2::1"));
    expect(body.source.digest).not.toBe(digestSourceAddress("2001:db8:1:3::1"));
  });
});
