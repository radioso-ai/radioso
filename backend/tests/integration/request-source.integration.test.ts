import { createEdgeFactsProof, EDGE_FACTS_HEADERS } from "@radioso/edge-proof";
import { digestSourceAddress } from "@radioso/mcp-source-proof";
import { Router } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import type { ApplicationRouteMount } from "../../src/app/composition/applicationModule.js";
import { readRequestSource } from "../../src/app/http/middleware/requestSource.js";
import { readEdgeFactsEnvelope } from "../../src/shared/domain/edgeFactsEnvelope.js";
import { resolveRequestSourceAddress } from "../../src/shared/domain/requestSource.js";
import { createTestApp } from "../support/testApp.js";

const SECRET = "e".repeat(32);
const ECHO_PATH = "/__test/request-source/echo";
const CLIENT = "203.0.113.7";
const FORGED = "198.51.100.99";
const FRONTEND_EGRESS = "34.96.0.5";

// Hosted Cloud Run: its front end appends exactly the connecting peer, on
// run.app and on mapped domains alike, so the backend trusts one hop.
const HOSTED_HOPS = 1;

interface EchoBody {
  ip: string | undefined;
  socketAddress: string | null;
  source: { address: string | null; digest: string };
  mountDigest: string;
}

const echoMount: ApplicationRouteMount = {
  path: "/__test/request-source",
  createRouter(dependencies) {
    const router = Router();
    router.get("/echo", (req, res) => {
      res.status(200).json({
        ip: req.ip,
        socketAddress: req.socket.remoteAddress ?? null,
        source: readRequestSource(req, res),
        mountDigest: dependencies.requestSource.digest(req, res),
      } satisfies EchoBody);
    });
    return router;
  },
};

const createEchoApp = (envOverrides: { RADIOSO_TRUSTED_PROXY_HOPS: number; RADIOSO_EDGE_PROOF_SECRET?: string }) =>
  createTestApp({ applicationRouteMounts: [echoMount], envOverrides }).app;

// The frontend is a Cloud Run service too: the chain it receives ends with the
// visitor and it signs that chain, while the backend's own chain has the
// frontend's egress appended after it.
const relayedThroughFrontend = (receivedChain: string): Record<string, string> => ({
  [EDGE_FACTS_HEADERS.marker]: "frontend",
  ...createEdgeFactsProof({
    facts: { forwardedFor: receivedChain, geoHeaders: {}, userAgent: null, acceptLanguage: null },
    method: "GET",
    path: ECHO_PATH,
    secret: SECRET,
  }).headers,
  "x-forwarded-for": `${receivedChain}, ${FRONTEND_EGRESS}`,
});

describe("request source", () => {
  it("leaves req.ip on the socket peer whatever X-Forwarded-For claims", async () => {
    const app = createEchoApp({ RADIOSO_TRUSTED_PROXY_HOPS: HOSTED_HOPS });

    const { body } = await request(app)
      .get(ECHO_PATH)
      .set("X-Forwarded-For", `${FORGED}, ${CLIENT}`)
      .expect(200) as { body: EchoBody };

    expect(body.ip).toBe(body.socketAddress);
    expect(body.ip).not.toBe(CLIENT);
  });

  it("publishes the entry Cloud Run appended for a direct caller, the same value the resolver computes", async () => {
    const app = createEchoApp({ RADIOSO_TRUSTED_PROXY_HOPS: HOSTED_HOPS });
    const forwardedFor = `${FORGED}, ${CLIENT}`;

    const { body } = await request(app)
      .get(ECHO_PATH)
      .set("X-Forwarded-For", forwardedFor)
      .expect(200) as { body: EchoBody };

    expect(body.source.address).toBe(CLIENT);
    expect(body.source.address).toBe(resolveRequestSourceAddress({
      headers: { "x-forwarded-for": forwardedFor },
      socketAddress: body.socketAddress,
      trustedProxyHops: HOSTED_HOPS,
      envelope: { status: "absent" },
    }));
    expect(body.source.digest).toBe(digestSourceAddress(CLIENT));
    expect(body.mountDigest).toBe(body.source.digest);
  });

  it("publishes the visitor from a verified frontend envelope rather than the frontend's egress the backend received", async () => {
    const app = createEchoApp({ RADIOSO_TRUSTED_PROXY_HOPS: HOSTED_HOPS, RADIOSO_EDGE_PROOF_SECRET: SECRET });
    const headers = relayedThroughFrontend(CLIENT);

    const { body } = await request(app)
      .get(`${ECHO_PATH}?probe=1`)
      .set(headers)
      .expect(200) as { body: EchoBody };

    expect(body.source.address).toBe(CLIENT);
    expect(body.source.address).toBe(resolveRequestSourceAddress({
      headers,
      socketAddress: body.socketAddress,
      trustedProxyHops: HOSTED_HOPS,
      envelope: readEdgeFactsEnvelope({ headers, secret: SECRET, method: "GET", path: ECHO_PATH }),
    }));
    expect(body.mountDigest).toBe(digestSourceAddress(CLIENT));
  });

  it("publishes the visitor from a verified envelope whose chain carries a prefix the visitor forged", async () => {
    const app = createEchoApp({ RADIOSO_TRUSTED_PROXY_HOPS: HOSTED_HOPS, RADIOSO_EDGE_PROOF_SECRET: SECRET });

    const { body } = await request(app)
      .get(ECHO_PATH)
      .set(relayedThroughFrontend(`${FORGED}, ${CLIENT}`))
      .expect(200) as { body: EchoBody };

    expect(body.source.address).toBe(CLIENT);
    expect(body.mountDigest).toBe(digestSourceAddress(CLIENT));
  });

  it("publishes the socket peer when the backend trusts no proxy hops", async () => {
    const app = createEchoApp({ RADIOSO_TRUSTED_PROXY_HOPS: 0 });

    const { body } = await request(app)
      .get(ECHO_PATH)
      .set("X-Forwarded-For", CLIENT)
      .expect(200) as { body: EchoBody };

    expect(body.source.address).toBe(body.socketAddress);
    expect(body.source.digest).toBe(digestSourceAddress(body.socketAddress ?? "unknown"));
  });
});
