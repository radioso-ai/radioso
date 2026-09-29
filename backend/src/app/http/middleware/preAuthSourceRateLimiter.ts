import type { RequestHandler } from "express";
import { MCP_SOURCE_PROOF_HEADERS, verifyMcpSourceProof } from "@radioso/mcp-source-proof";

import { forbidden } from "../../../shared/domain/errors.js";
import { readRequestSource } from "./requestSource.js";

/**
 * Pre-authentication limiters spend budget and answer with a bare rejection, so they never read
 * the decision back and never advertise a budget to an unauthenticated caller.
 */
export interface PreAuthSourceAbuseControlPort {
  enforce(input: {
    scope: string;
    subjectKey: string;
    limit: number;
    windowMs: number;
  }): Promise<unknown>;
}

const singleHeader = (value: string | string[] | undefined): string | null =>
  typeof value === "string" ? value : null;

const verifiedMcpSourceDigest = (
  req: Parameters<RequestHandler>[0],
  signingSecret?: string,
): string | null => {
  if (!signingSecret) return null;
  const sourceDigest = singleHeader(req.headers[MCP_SOURCE_PROOF_HEADERS.digest]);
  const signature = singleHeader(req.headers[MCP_SOURCE_PROOF_HEADERS.signature]);
  const timestamp = singleHeader(req.headers[MCP_SOURCE_PROOF_HEADERS.timestamp]);
  if (!sourceDigest || !signature || !timestamp) return null;
  const path = req.originalUrl.split("?", 1)[0] ?? req.path;
  return verifyMcpSourceProof({
    method: req.method,
    path,
    secret: signingSecret,
    signature,
    sourceDigest,
    timestamp,
  });
};

interface PreAuthSourceLocals {
  /**
   * The calling source's opaque digest, resolved once per request by the first source
   * limiter on the route. Later middleware budgets and audits by it rather than
   * recomputing — two resolutions of the same request must never disagree.
   */
  preAuthSourceDigest: string;
}

/** Publishes the digest for later middleware on the same request. */
export const publishPreAuthSourceDigest = (
  res: Parameters<RequestHandler>[1],
  sourceDigest: string,
): string => {
  (res.locals as typeof res.locals & PreAuthSourceLocals).preAuthSourceDigest = sourceDigest;
  return sourceDigest;
};

export const readPreAuthSourceDigest = (
  res: Parameters<RequestHandler>[1],
): string | null =>
  (res.locals as typeof res.locals & Partial<PreAuthSourceLocals>).preAuthSourceDigest ?? null;

/**
 * The standalone MCP server's signed digest names the caller it saw, so it wins over
 * everything this backend observed. Otherwise the request source the app published, which
 * already prefers a verified frontend edge envelope over this backend's own forwarded chain.
 */
export const resolvedPreAuthSourceDigest = (
  req: Parameters<RequestHandler>[0],
  res: Parameters<RequestHandler>[1],
  signingSecret?: string,
): string => verifiedMcpSourceDigest(req, signingSecret) ?? readRequestSource(req, res).digest;

export const requireValidMcpSourceProof = (signingSecret?: string): RequestHandler => (req, _res, next) => {
  if (!verifiedMcpSourceDigest(req, signingSecret)) {
    next(forbidden("Valid standalone MCP source proof required."));
    return;
  }
  next();
};

export const createPreAuthSourceRateLimiter = (input: {
  service: PreAuthSourceAbuseControlPort;
  scope: string;
  limit: number;
  signingSecret?: string;
  windowMs: number;
  onFailure?: (input: { outcome: "limited" | "unavailable" }) => void;
}): RequestHandler => async (req, res, next) => {
  try {
    const sourceDigest = publishPreAuthSourceDigest(
      res,
      resolvedPreAuthSourceDigest(req, res, input.signingSecret),
    );
    await input.service.enforce({
      scope: input.scope,
      subjectKey: `source:${sourceDigest}`,
      limit: input.limit,
      windowMs: input.windowMs,
    });
    next();
  } catch (error) {
    const statusCode = error && typeof error === "object" && "statusCode" in error
      ? (error as { statusCode?: unknown }).statusCode
      : undefined;
    try {
      input.onFailure?.({ outcome: statusCode === 429 ? "limited" : "unavailable" });
    } catch {
      // Admission control must not depend on telemetry.
    }
    next(error);
  }
};
