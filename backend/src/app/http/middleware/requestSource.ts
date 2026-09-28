import type { Request, RequestHandler, Response } from "express";
import { digestSourceAddress } from "@radioso/mcp-source-proof";

import { readEdgeFactsEnvelope, type EdgeFactsEnvelopeReading } from "../../../shared/domain/edgeFactsEnvelope.js";
import { resolveRequestSourceAddress } from "../../../shared/domain/requestSource.js";
import type { MetricsRegistry } from "../../../shared/observability/metrics/metricsRegistry.js";
import type { Env } from "../../config/env.js";

/**
 * One inbound request's source. `address` is the full client address, for
 * audit records whose job is to keep it; `digest` stands in for it in
 * rate-limit subject keys, which persist and are echoed into audit metadata.
 * The digest keys an IPv6 caller on its /64, so rotating through one
 * allocation cannot mint fresh budgets. It is opaque, not anonymous: its key
 * is a public constant, so an IPv4 digest can be reversed by enumerating the
 * address space.
 */
interface RequestSource {
  address: string | null;
  digest: string;
}

interface RequestSourceLocals {
  requestSource: RequestSource;
  edgeFactsEnvelope: EdgeFactsEnvelopeReading;
}

interface RequestSourceMiddlewareDependencies {
  env: Pick<Env, "RADIOSO_TRUSTED_PROXY_HOPS" | "RADIOSO_EDGE_PROOF_SECRET">;
  metricsRegistry: Pick<MetricsRegistry, "incrementCounter"> | null;
}

const requestSourceFor = (address: string | null): RequestSource => ({
  address,
  digest: digestSourceAddress(address ?? "unknown"),
});

/**
 * Resolves the request source once, before any router runs, and publishes it
 * with the edge-facts envelope reading it came from.
 *
 * This is the one place a rejected envelope is counted. Budgeting falls back
 * to the backend's own observation, so a secret rotated on one service or
 * clock skew past the proof window would otherwise only show as every relayed
 * caller sharing the edge's egress budget. A backend with no secret never
 * runs the proof path, so the marker the frontend always sends counts as
 * nothing there. The counter carries the reason alone, never an address or
 * header.
 */
export const createRequestSourceMiddleware = (
  dependencies: RequestSourceMiddlewareDependencies,
): RequestHandler => (req, res, next) => {
  const { env, metricsRegistry } = dependencies;
  const envelope = readEdgeFactsEnvelope({
    headers: req.headers,
    secret: env.RADIOSO_EDGE_PROOF_SECRET,
    method: req.method,
    path: req.originalUrl.split("?", 1)[0] ?? req.path,
  });
  if (envelope.status === "rejected" && env.RADIOSO_EDGE_PROOF_SECRET) {
    metricsRegistry?.incrementCounter("edge_facts_proof_rejected_total", {
      help: "Edge-facts proof rejections by reason.",
      labels: { reason: envelope.reason },
    });
  }

  const locals = res.locals as typeof res.locals & RequestSourceLocals;
  locals.edgeFactsEnvelope = envelope;
  locals.requestSource = requestSourceFor(resolveRequestSourceAddress({
    headers: req.headers,
    socketAddress: req.socket.remoteAddress ?? null,
    trustedProxyHops: env.RADIOSO_TRUSTED_PROXY_HOPS,
    envelope,
  }));
  next();
};

/**
 * Every consumer reads the published value, so two readings of one request
 * never disagree. A router exercised without the app-level middleware (a test
 * building a limiter directly) gets the socket peer, never a forwarded header.
 */
export const readRequestSource = (
  req: Pick<Request, "socket">,
  res: Pick<Response, "locals">,
): RequestSource =>
  (res.locals as Partial<RequestSourceLocals>).requestSource
    ?? requestSourceFor(req.socket?.remoteAddress ?? null);

/**
 * The envelope reading the middleware took, so conversation request context
 * reuses it instead of verifying the proof again. Undefined when the
 * middleware did not run.
 */
export const readPublishedEdgeFactsEnvelope = (
  res: Pick<Response, "locals">,
): EdgeFactsEnvelopeReading | undefined =>
  (res.locals as Partial<RequestSourceLocals>).edgeFactsEnvelope;

/** What application route mounts read: a stable per-source key, never the address itself. */
export interface RequestSourceDigestPort {
  digest(req: Request, res: Response): string;
}

export const requestSourceDigestPort: RequestSourceDigestPort = {
  digest: (req, res) => readRequestSource(req, res).digest,
};
