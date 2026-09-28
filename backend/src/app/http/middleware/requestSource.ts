import type { Request, RequestHandler, Response } from "express";
import { digestSourceAddress } from "@radioso/mcp-source-proof";

import { resolveRequestSourceAddress } from "../../../shared/domain/requestSource.js";
import type { Env } from "../../config/env.js";

/**
 * One inbound request's source. `address` is the raw client address, for audit
 * records whose job is to keep it; `digest` is its opaque stand-in for
 * rate-limit subject keys, which persist and are echoed into audit metadata,
 * so they must never hold a real client address.
 */
interface RequestSource {
  address: string | null;
  digest: string;
}

interface RequestSourceLocals {
  requestSource: RequestSource;
}

const requestSourceFor = (address: string | null): RequestSource => ({
  address,
  digest: digestSourceAddress(address ?? "unknown"),
});

/** Resolves the request source once, before any router runs, and publishes it for the rest of the request. */
export const createRequestSourceMiddleware = (
  env: Pick<Env, "RADIOSO_TRUSTED_PROXY_HOPS" | "RADIOSO_EDGE_PROOF_SECRET">,
): RequestHandler => (req, res, next) => {
  (res.locals as typeof res.locals & RequestSourceLocals).requestSource = requestSourceFor(
    resolveRequestSourceAddress({
      headers: req.headers,
      socketAddress: req.socket.remoteAddress ?? null,
      trustedProxyHops: env.RADIOSO_TRUSTED_PROXY_HOPS,
      secret: env.RADIOSO_EDGE_PROOF_SECRET,
      method: req.method,
      path: req.originalUrl.split("?", 1)[0] ?? req.path,
    }),
  );
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

/** What application route mounts read: a stable per-source key, never the address itself. */
export interface RequestSourceDigestPort {
  digest(req: Request, res: Response): string;
}

export const requestSourceDigestPort: RequestSourceDigestPort = {
  digest: (req, res) => readRequestSource(req, res).digest,
};
