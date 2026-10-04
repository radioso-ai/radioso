import { createEdgeFactsProof, EDGE_FACTS_HEADERS } from "@radioso/edge-proof";
import {
  createMcpSourceProof,
  digestSourceAddress,
  MCP_SOURCE_PROOF_HEADERS,
  resolveSourceDigest,
} from "@radioso/mcp-source-proof";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import {
  createPreAuthSourceRateLimiter,
  readPreAuthSourceDigest,
} from "../../src/app/http/middleware/preAuthSourceRateLimiter.js";
import { createRequestSourceMiddleware } from "../../src/app/http/middleware/requestSource.js";

const EDGE_SECRET = "e".repeat(32);
const MCP_SECRET = "m".repeat(32);
const PATH = "/limited";
const CLIENT = "203.0.113.10";
const FORGED = "198.51.100.99";
const FRONTEND_EGRESS = "34.96.0.5";
const MCP_CALLER = "192.0.2.44";

interface Observed {
  forwardedFor: string | null;
  socketAddress: string | null;
  sourceDigest: string | null;
}

const createLimitedApp = (options: {
  requestSource?: { trustedProxyHops: number; edgeProofSecret?: string };
  mcpSigningSecret?: string;
}) => {
  const enforce = vi.fn().mockResolvedValue(undefined);
  const app = express();
  if (options.requestSource) {
    app.use(createRequestSourceMiddleware({
      env: {
        RADIOSO_TRUSTED_PROXY_HOPS: options.requestSource.trustedProxyHops,
        RADIOSO_EDGE_PROOF_SECRET: options.requestSource.edgeProofSecret,
      },
      metricsRegistry: null,
    }));
  }
  app.get(PATH, createPreAuthSourceRateLimiter({
    service: { enforce },
    scope: "test.source",
    limit: 10,
    windowMs: 60_000,
    signingSecret: options.mcpSigningSecret,
  }), (req, res) => {
    const forwardedFor = req.headers["x-forwarded-for"];
    const observed: Observed = {
      forwardedFor: typeof forwardedFor === "string" ? forwardedFor : null,
      socketAddress: req.socket.remoteAddress ?? null,
      sourceDigest: readPreAuthSourceDigest(res),
    };
    res.status(200).json(observed);
  });
  return { app, enforce };
};

const signedEnvelope = (forwardedFor: string): Record<string, string> => ({
  [EDGE_FACTS_HEADERS.marker]: "frontend",
  ...createEdgeFactsProof({
    facts: { forwardedFor, geoHeaders: {}, userAgent: null, acceptLanguage: null },
    method: "GET",
    path: PATH,
    secret: EDGE_SECRET,
  }).headers,
});

const mcpSourceProofFor = (address: string): Record<string, string> => {
  const proof = createMcpSourceProof({
    method: "GET",
    path: PATH,
    secret: MCP_SECRET,
    sourceDigest: digestSourceAddress(address),
  });
  return {
    [MCP_SOURCE_PROOF_HEADERS.digest]: proof.sourceDigest,
    [MCP_SOURCE_PROOF_HEADERS.timestamp]: proof.timestamp,
    [MCP_SOURCE_PROOF_HEADERS.signature]: proof.signature,
  };
};

const subjectKeys = (enforce: ReturnType<typeof vi.fn>): string[] =>
  enforce.mock.calls.map(([input]) => (input as { subjectKey: string }).subjectKey);

describe("pre-auth source rate limiter", () => {
  it("keys a relayed request on the visitor from the published request source", async () => {
    const { app, enforce } = createLimitedApp({
      requestSource: { trustedProxyHops: 1, edgeProofSecret: EDGE_SECRET },
    });

    const { body } = await request(app)
      .get(PATH)
      .set(signedEnvelope(`${FORGED}, ${CLIENT}`))
      .set("X-Forwarded-For", `${CLIENT}, ${FRONTEND_EGRESS}`)
      .expect(200) as { body: Observed };

    expect(subjectKeys(enforce)).toEqual([`source:${digestSourceAddress(CLIENT)}`]);
    expect(body.sourceDigest).toBe(digestSourceAddress(CLIENT));
  });

  it("prefers a verified MCP source proof over a verified edge envelope", async () => {
    const { app, enforce } = createLimitedApp({
      requestSource: { trustedProxyHops: 1, edgeProofSecret: EDGE_SECRET },
      mcpSigningSecret: MCP_SECRET,
    });

    await request(app)
      .get(PATH)
      .set(signedEnvelope(`${FORGED}, ${CLIENT}`))
      .set(mcpSourceProofFor(MCP_CALLER))
      .set("X-Forwarded-For", `${CLIENT}, ${FRONTEND_EGRESS}`)
      .expect(200);

    expect(subjectKeys(enforce)).toEqual([`source:${digestSourceAddress(MCP_CALLER)}`]);
  });

  it("ignores an MCP source proof when no signing secret is configured", async () => {
    const { app, enforce } = createLimitedApp({
      requestSource: { trustedProxyHops: 1, edgeProofSecret: EDGE_SECRET },
    });

    await request(app)
      .get(PATH)
      .set(mcpSourceProofFor(MCP_CALLER))
      .set("X-Forwarded-For", `${FORGED}, ${CLIENT}`)
      .expect(200);

    expect(subjectKeys(enforce)).toEqual([`source:${digestSourceAddress(CLIENT)}`]);
  });

  // A deploy must not reset a direct caller's budget: with no envelope in play, the key is
  // byte-identical to the one the limiter derived from the forwarded chain itself.
  it.each([
    { hops: 0, forwardedFor: `${FORGED}, ${CLIENT}`, edgeProofSecret: EDGE_SECRET, envelope: false },
    { hops: 1, forwardedFor: `${FORGED}, ${CLIENT}`, edgeProofSecret: EDGE_SECRET, envelope: false },
    { hops: 2, forwardedFor: `${FORGED}, ${CLIENT}, ${FRONTEND_EGRESS}`, edgeProofSecret: EDGE_SECRET, envelope: false },
    { hops: 3, forwardedFor: CLIENT, edgeProofSecret: EDGE_SECRET, envelope: false },
    { hops: 1, forwardedFor: `${CLIENT}, not-an-address`, edgeProofSecret: EDGE_SECRET, envelope: false },
    { hops: 1, forwardedFor: "2001:db8:1:2:aaaa:bbbb:cccc:dddd", edgeProofSecret: EDGE_SECRET, envelope: false },
    { hops: 1, forwardedFor: null, edgeProofSecret: EDGE_SECRET, envelope: false },
    { hops: 1, forwardedFor: `${CLIENT}, ${FRONTEND_EGRESS}`, edgeProofSecret: undefined, envelope: true },
  ])("keys hops=$hops chain=$forwardedFor envelope=$envelope exactly as before", async (testCase) => {
    const { app, enforce } = createLimitedApp({
      requestSource: { trustedProxyHops: testCase.hops, edgeProofSecret: testCase.edgeProofSecret },
    });
    const pending = request(app).get(PATH);
    if (testCase.forwardedFor) pending.set("X-Forwarded-For", testCase.forwardedFor);
    // Signed, but this backend holds no secret, so the envelope cannot verify.
    if (testCase.envelope) pending.set(signedEnvelope(`${FORGED}, ${CLIENT}`));

    const { body } = await pending.expect(200) as { body: Observed };

    const previousDigest = resolveSourceDigest({
      forwardedFor: body.forwardedFor ?? undefined,
      socketAddress: body.socketAddress,
      trustedProxyHops: testCase.hops,
    });
    expect(subjectKeys(enforce)).toEqual([`source:${previousDigest}`]);
  });

  it("keys on the socket peer, never X-Forwarded-For, when the request-source middleware did not run", async () => {
    const { app, enforce } = createLimitedApp({});

    const { body } = await request(app)
      .get(PATH)
      .set("X-Forwarded-For", `${FORGED}, ${CLIENT}`)
      .expect(200) as { body: Observed };

    expect(body.socketAddress).toBeTruthy();
    expect(subjectKeys(enforce)).toEqual([`source:${digestSourceAddress(body.socketAddress ?? "")}`]);
  });
});
