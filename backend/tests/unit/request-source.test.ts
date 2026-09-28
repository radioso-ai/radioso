import { createEdgeFactsProof, EDGE_FACTS_HEADERS } from "@radioso/edge-proof";
import { digestSourceAddress } from "@radioso/mcp-source-proof";
import type { Request, Response } from "express";
import { describe, expect, it } from "vitest";

import { readRequestSource } from "../../src/app/http/middleware/requestSource.js";
import { resolveRequestSourceAddress } from "../../src/shared/domain/requestSource.js";

const SECRET = "a".repeat(32);
const METHOD = "POST";
const PATH = "/api/v1/public/chat/token123/sessions";
const NOW = new Date("2026-09-28T00:00:00.000Z");

const CLIENT = "203.0.113.9";
const LOAD_BALANCER = "35.191.0.1";
const FRONTEND_EGRESS = "34.96.0.5";
const SOCKET = "169.254.1.1";

const signedEnvelope = (forwardedFor: string | null, secret = SECRET) => ({
  [EDGE_FACTS_HEADERS.marker]: "frontend",
  ...createEdgeFactsProof({
    facts: { forwardedFor, geoHeaders: {}, userAgent: null, acceptLanguage: null },
    method: METHOD,
    path: PATH,
    secret,
    now: NOW,
  }).headers,
});

const resolve = (input: {
  headers?: Record<string, string>;
  trustedProxyHops: number;
  secret?: string;
}) => resolveRequestSourceAddress({
  headers: input.headers ?? {},
  socketAddress: SOCKET,
  trustedProxyHops: input.trustedProxyHops,
  secret: input.secret,
  method: METHOD,
  path: PATH,
  now: NOW,
});

describe("resolveRequestSourceAddress", () => {
  describe("the backend's own observation", () => {
    it("ignores X-Forwarded-For entirely at zero trusted hops", () => {
      expect(resolve({ headers: { "x-forwarded-for": CLIENT }, trustedProxyHops: 0 })).toBe(SOCKET);
    });

    it("takes the first entry of the trusted suffix, never a caller-controlled prefix", () => {
      expect(resolve({
        headers: { "x-forwarded-for": `198.51.100.99, ${CLIENT}, ${LOAD_BALANCER}` },
        trustedProxyHops: 2,
      })).toBe(CLIENT);
    });

    it("falls back to the socket when the chain is shorter than the trusted hop count", () => {
      expect(resolve({ headers: { "x-forwarded-for": LOAD_BALANCER }, trustedProxyHops: 2 })).toBe(SOCKET);
    });

    it("falls back to the socket when the trusted suffix holds a non-address entry", () => {
      expect(resolve({
        headers: { "x-forwarded-for": `${CLIENT}, not-an-address` },
        trustedProxyHops: 2,
      })).toBe(SOCKET);
    });
  });

  describe("a frontend edge-facts envelope", () => {
    it("resolves the chain the frontend received, not the longer chain the backend received", () => {
      expect(resolve({
        headers: {
          ...signedEnvelope(`${CLIENT}, ${LOAD_BALANCER}`),
          "x-forwarded-for": `${CLIENT}, ${LOAD_BALANCER}, ${FRONTEND_EGRESS}`,
        },
        trustedProxyHops: 2,
        secret: SECRET,
      })).toBe(CLIENT);
    });

    it("falls back to the backend's own observation when a verified envelope yields no address", () => {
      expect(resolve({
        headers: {
          ...signedEnvelope(null),
          "x-forwarded-for": `${CLIENT}, ${LOAD_BALANCER}`,
        },
        trustedProxyHops: 2,
        secret: SECRET,
      })).toBe(CLIENT);
    });

    it("ignores an envelope that fails verification and keeps the backend's own observation", () => {
      expect(resolve({
        headers: {
          ...signedEnvelope(`198.51.100.99, ${LOAD_BALANCER}`, "b".repeat(32)),
          "x-forwarded-for": `${CLIENT}, ${LOAD_BALANCER}`,
        },
        trustedProxyHops: 2,
        secret: SECRET,
      })).toBe(CLIENT);
    });

    it("ignores a marker with no proof and keeps the backend's own observation", () => {
      expect(resolve({
        headers: {
          [EDGE_FACTS_HEADERS.marker]: "frontend",
          "x-forwarded-for": `${CLIENT}, ${LOAD_BALANCER}`,
        },
        trustedProxyHops: 2,
        secret: SECRET,
      })).toBe(CLIENT);
    });

    it("never trusts an envelope when this backend has no edge-proof secret", () => {
      expect(resolve({
        headers: {
          ...signedEnvelope(`198.51.100.99, ${LOAD_BALANCER}`),
          "x-forwarded-for": `${CLIENT}, ${LOAD_BALANCER}`,
        },
        trustedProxyHops: 2,
      })).toBe(CLIENT);
    });
  });

  it("returns null when there is neither a trusted chain nor a socket address", () => {
    expect(resolveRequestSourceAddress({
      headers: {},
      socketAddress: null,
      trustedProxyHops: 2,
      secret: SECRET,
      method: METHOD,
      path: PATH,
      now: NOW,
    })).toBeNull();
  });
});

describe("readRequestSource", () => {
  it("falls back to the socket peer, never X-Forwarded-For, when the app-level middleware did not run", () => {
    const req = {
      headers: { "x-forwarded-for": `${CLIENT}, ${LOAD_BALANCER}` },
      socket: { remoteAddress: SOCKET },
    } as unknown as Request;
    const res = { locals: {} } as unknown as Response;

    expect(readRequestSource(req, res)).toEqual({ address: SOCKET, digest: digestSourceAddress(SOCKET) });
  });
});
