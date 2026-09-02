import type { RequestHandler } from "express";
import {
  MCP_SOURCE_PROOF_HEADERS,
  resolveSourceDigest,
  verifyMcpSourceProof,
} from "@radioso/mcp-source-proof";

import { forbidden } from "../../../shared/domain/errors.js";
import type { RateLimitAbuseControlPort } from "./rateLimit.js";

export const preAuthSourceDigest = (
  req: Parameters<RequestHandler>[0],
  trustedProxyHops = 0,
): string => resolveSourceDigest({
  forwardedFor: req.headers["x-forwarded-for"],
  socketAddress: req.socket.remoteAddress,
  trustedProxyHops,
});

const singleHeader = (value: string | string[] | undefined): string | null =>
  typeof value === "string" ? value : null;

export const verifiedMcpSourceDigest = (
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

export const resolvedPreAuthSourceDigest = (
  req: Parameters<RequestHandler>[0],
  signingSecret?: string,
  trustedProxyHops = 0,
): string => {
  return verifiedMcpSourceDigest(req, signingSecret) ?? preAuthSourceDigest(req, trustedProxyHops);
};

export const requireValidMcpSourceProof = (signingSecret?: string): RequestHandler => (req, _res, next) => {
  if (!verifiedMcpSourceDigest(req, signingSecret)) {
    next(forbidden("Valid standalone MCP source proof required."));
    return;
  }
  next();
};

export const createPreAuthSourceRateLimiter = (input: {
  service: RateLimitAbuseControlPort;
  scope: string;
  limit: number;
  signingSecret?: string;
  trustedProxyHops?: number;
  windowMs: number;
  onFailure?: (input: { outcome: "limited" | "unavailable" }) => void;
}): RequestHandler => async (req, _res, next) => {
  try {
    await input.service.enforce({
      scope: input.scope,
      subjectKey: `source:${resolvedPreAuthSourceDigest(req, input.signingSecret, input.trustedProxyHops)}`,
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
