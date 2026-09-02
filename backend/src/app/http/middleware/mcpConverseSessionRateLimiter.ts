import { createHash } from "node:crypto";
import type { RequestHandler } from "express";

import type { Env } from "../../config/env.js";
import type { MetricsRegistry } from "../../../shared/observability/metrics/metricsRegistry.js";
import { createPreAuthSourceRateLimiter } from "./preAuthSourceRateLimiter.js";

interface McpConverseSessionRateLimiterDependencies {
  env: Pick<Env,
    | "MCP_CONVERSE_SESSION_RATE_LIMIT_WINDOW_MS"
    | "MCP_CONVERSE_SESSION_SOURCE_RATE_LIMIT_MAX_ATTEMPTS"
    | "MCP_CONVERSE_SESSION_TOKEN_RATE_LIMIT_MAX_ATTEMPTS"
    | "RADIOSO_MCP_SIGNING_SECRET"
    | "RADIOSO_TRUSTED_PROXY_HOPS"
  >;
  abuseControlService: {
    enforce(input: {
      scope: string;
      subjectKey: string;
      limit: number;
      windowMs: number;
    }): Promise<unknown>;
  };
  metricsRegistry?: Pick<MetricsRegistry, "incrementCounter"> | null;
}

const digest = (value: string): string => createHash("sha256").update(value).digest("base64url");

/**
 * Limits the unauthenticated exchange before it can perform a grant lookup.
 * The source bucket is deliberately consumed first: a flood of distinct bogus
 * tokens can create at most the source bucket's bounded number of token keys.
 * Only digests enter the durable store, audit payloads, and logs.
 */
export const createMcpConverseSourceRateLimiter = (
  dependencies: McpConverseSessionRateLimiterDependencies,
): RequestHandler => createPreAuthSourceRateLimiter({
  service: dependencies.abuseControlService,
  scope: "mcp.converse.session.source",
  limit: dependencies.env.MCP_CONVERSE_SESSION_SOURCE_RATE_LIMIT_MAX_ATTEMPTS,
  signingSecret: dependencies.env.RADIOSO_MCP_SIGNING_SECRET,
  trustedProxyHops: dependencies.env.RADIOSO_TRUSTED_PROXY_HOPS,
  windowMs: dependencies.env.MCP_CONVERSE_SESSION_RATE_LIMIT_WINDOW_MS,
  onFailure: ({ outcome }) => dependencies.metricsRegistry?.incrementCounter(
    "mcp_converse_session_exchange_abuse_control_failures_total",
    {
      help: "MCP converse session exchange abuse-control outcomes.",
      labels: { stage: "source", outcome },
    },
  ),
});

export const createMcpConverseTokenRateLimiter = (
  dependencies: McpConverseSessionRateLimiterDependencies,
): RequestHandler => async (req, _res, next) => {
  const launchToken = typeof req.body?.launchToken === "string" ? req.body.launchToken : "";
  try {
    await dependencies.abuseControlService.enforce({
      scope: "mcp.converse.session.token",
      subjectKey: `token:${digest(launchToken)}`,
      limit: dependencies.env.MCP_CONVERSE_SESSION_TOKEN_RATE_LIMIT_MAX_ATTEMPTS,
      windowMs: dependencies.env.MCP_CONVERSE_SESSION_RATE_LIMIT_WINDOW_MS,
    });
    next();
  } catch (error) {
    // Pre-authentication failures intentionally have no audit write here. The
    // source bucket bounds the durable work for invalid-token floods.
    const statusCode = error && typeof error === "object" && "statusCode" in error
      ? (error as { statusCode?: unknown }).statusCode
      : undefined;
    dependencies.metricsRegistry?.incrementCounter("mcp_converse_session_exchange_abuse_control_failures_total", {
      help: "MCP converse session exchange abuse-control outcomes.",
      labels: {
        stage: "token",
        outcome: statusCode === 429 ? "limited" : "unavailable",
      },
    });
    next(error);
  }
};
