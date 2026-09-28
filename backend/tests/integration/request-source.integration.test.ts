import { createEdgeFactsProof, EDGE_FACTS_HEADERS } from "@radioso/edge-proof";
import { digestSourceAddress } from "@radioso/mcp-source-proof";
import { Router } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import type { ApplicationRouteMount } from "../../src/app/composition/applicationModule.js";
import { readRequestSource } from "../../src/app/http/middleware/requestSource.js";
import { resolveRequestSourceAddress } from "../../src/shared/domain/requestSource.js";
import { createTestApp } from "../support/testApp.js";

const SECRET = "e".repeat(32);
const ECHO_PATH = "/__test/request-source/echo";
const CLIENT = "203.0.113.7";
const LOAD_BALANCER = "35.191.0.1";
const FRONTEND_EGRESS = "34.96.0.5";

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

describe("request source", () => {
  it("leaves req.ip on the socket peer whatever X-Forwarded-For claims", async () => {
    const app = createEchoApp({ RADIOSO_TRUSTED_PROXY_HOPS: 2 });

    const { body } = await request(app)
      .get(ECHO_PATH)
      .set("X-Forwarded-For", `198.51.100.99, ${CLIENT}, ${LOAD_BALANCER}`)
      .expect(200) as { body: EchoBody };

    expect(body.ip).toBe(body.socketAddress);
    expect(body.ip).not.toBe(CLIENT);
  });

  it("publishes the backend's own trusted-suffix observation, the same value the resolver computes", async () => {
    const app = createEchoApp({ RADIOSO_TRUSTED_PROXY_HOPS: 2 });
    const forwardedFor = `198.51.100.99, ${CLIENT}, ${LOAD_BALANCER}`;

    const { body } = await request(app)
      .get(ECHO_PATH)
      .set("X-Forwarded-For", forwardedFor)
      .expect(200) as { body: EchoBody };

    expect(body.source.address).toBe(CLIENT);
    expect(body.source.address).toBe(resolveRequestSourceAddress({
      headers: { "x-forwarded-for": forwardedFor },
      socketAddress: body.socketAddress,
      trustedProxyHops: 2,
      secret: undefined,
      method: "GET",
      path: ECHO_PATH,
    }));
    expect(body.source.digest).toBe(digestSourceAddress(CLIENT));
    expect(body.mountDigest).toBe(body.source.digest);
  });

  it("publishes the client from a verified frontend envelope rather than the longer chain the backend received", async () => {
    const app = createEchoApp({ RADIOSO_TRUSTED_PROXY_HOPS: 2, RADIOSO_EDGE_PROOF_SECRET: SECRET });
    const envelope = {
      [EDGE_FACTS_HEADERS.marker]: "frontend",
      ...createEdgeFactsProof({
        facts: {
          forwardedFor: `${CLIENT}, ${LOAD_BALANCER}`,
          geoHeaders: {},
          userAgent: null,
          acceptLanguage: null,
        },
        method: "GET",
        path: ECHO_PATH,
        secret: SECRET,
      }).headers,
    };
    const forwardedFor = `${CLIENT}, ${LOAD_BALANCER}, ${FRONTEND_EGRESS}`;

    const { body } = await request(app)
      .get(`${ECHO_PATH}?probe=1`)
      .set(envelope)
      .set("X-Forwarded-For", forwardedFor)
      .expect(200) as { body: EchoBody };

    expect(body.source.address).toBe(CLIENT);
    expect(body.source.address).toBe(resolveRequestSourceAddress({
      headers: { ...envelope, "x-forwarded-for": forwardedFor },
      socketAddress: body.socketAddress,
      trustedProxyHops: 2,
      secret: SECRET,
      method: "GET",
      path: ECHO_PATH,
    }));
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
