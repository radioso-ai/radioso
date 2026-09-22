import { createHash } from "node:crypto";
import type { RequestHandler } from "express";

import type { Env } from "../../config/env.js";
import type { AgentConversePrincipal } from "../../../modules/settings/contracts/agentConverseSession.js";
import type { MetricsRegistry } from "../../../shared/observability/metrics/metricsRegistry.js";
import {
  createPreAuthSourceRateLimiter,
  type PreAuthSourceAbuseControlPort,
} from "./preAuthSourceRateLimiter.js";
import {
  createRateLimitMiddleware,
  type RateLimitAbuseControlPort,
  type RateLimitAuditPort,
} from "./rateLimit.js";

interface McpConverseSessionRateLimiterDependencies {
  env: Pick<Env,
    | "MCP_CONVERSE_SESSION_RATE_LIMIT_WINDOW_MS"
    | "MCP_CONVERSE_SESSION_SOURCE_RATE_LIMIT_MAX_ATTEMPTS"
    | "MCP_CONVERSE_SESSION_TOKEN_RATE_LIMIT_MAX_ATTEMPTS"
    | "RADIOSO_MCP_SIGNING_SECRET"
    | "RADIOSO_TRUSTED_PROXY_HOPS"
  >;
  abuseControlService: PreAuthSourceAbuseControlPort;
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

/**
 * The conversation-update read has its own source budget rather than sharing the session
 * exchange's, because a read may park for up to 25 s: on one process each parked read
 * holds a client socket and, through the standalone MCP server, an upstream one. Bounding
 * the arrival rate is what bounds that concurrency — at the default 60 per minute, one
 * source can have at most ~25 reads overlapping.
 */
export const createMcpConverseMessagesSourceRateLimiter = (
  dependencies: McpConverseSessionRateLimiterDependencies & {
    env: Pick<Env, "MCP_CONVERSE_MESSAGES_SOURCE_RATE_LIMIT_MAX_ATTEMPTS">;
  },
): RequestHandler => createPreAuthSourceRateLimiter({
  service: dependencies.abuseControlService,
  scope: "mcp.converse.messages.source",
  limit: dependencies.env.MCP_CONVERSE_MESSAGES_SOURCE_RATE_LIMIT_MAX_ATTEMPTS,
  signingSecret: dependencies.env.RADIOSO_MCP_SIGNING_SECRET,
  trustedProxyHops: dependencies.env.RADIOSO_TRUSTED_PROXY_HOPS,
  windowMs: dependencies.env.MCP_CONVERSE_SESSION_RATE_LIMIT_WINDOW_MS,
});

interface McpConverseMessagesRateLimiterDependencies {
  env: Pick<Env,
    | "MCP_CONVERSE_SESSION_RATE_LIMIT_WINDOW_MS"
    | "MCP_CONVERSE_MESSAGES_RATE_LIMIT_MAX_ATTEMPTS"
  >;
  abuseControlService: RateLimitAbuseControlPort;
  auditService: RateLimitAuditPort;
}

/**
 * The read budget for resumption, charged once per call rather than per poll tick: a
 * caller that parks for 25 s spends one unit, the same as one that reads and leaves.
 * The session is the subject, so a credential-bound and a walk-in caller are budgeted
 * the same way without the limiter learning which is which.
 */
export const createMcpConverseMessagesRateLimiter = (
  dependencies: McpConverseMessagesRateLimiterDependencies,
): RequestHandler => createRateLimitMiddleware({
  service: dependencies.abuseControlService,
  auditService: dependencies.auditService,
  scope: "mcp.converse.messages.session",
  limit: dependencies.env.MCP_CONVERSE_MESSAGES_RATE_LIMIT_MAX_ATTEMPTS,
  windowMs: dependencies.env.MCP_CONVERSE_SESSION_RATE_LIMIT_WINDOW_MS,
  resolveSubjectKey: (_req, res) => {
    const principal = res.locals.mcpConversePrincipal as AgentConversePrincipal | undefined;
    return principal ? `session:${principal.publicSessionId}` : null;
  },
  resolveAuditContext: (_req, res) => {
    const principal = res.locals.mcpConversePrincipal as AgentConversePrincipal | undefined;
    return principal ? { workspaceId: principal.workspaceId, metadata: { agentId: principal.agentId } } : {};
  },
});

export const createMcpConverseTokenRateLimiter = (
  dependencies: McpConverseSessionRateLimiterDependencies,
): RequestHandler => async (req, _res, next) => {
  const launchToken = typeof req.body?.launchToken === "string" ? req.body.launchToken : "";
  if (!launchToken) {
    // A walk-in exchange presents no token; its own per-source and per-agent budgets
    // bound it, and spending this bucket would key every walk-in caller alike.
    next();
    return;
  }
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
