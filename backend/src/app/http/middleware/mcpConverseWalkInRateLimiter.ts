import type { RequestHandler } from "express";

import type { AgentRepositoryPort } from "../../../db/repositories/agentRepository.js";
import type { AgentConverseWalkInObserver } from "../../../modules/settings/contracts/agentConverseSession.js";
import type { Env } from "../../config/env.js";
import {
  publishPreAuthSourceDigest,
  readPreAuthSourceDigest,
  resolvedPreAuthSourceDigest,
  type PreAuthSourceAbuseControlPort,
} from "./preAuthSourceRateLimiter.js";
import type { RateLimitAuditPort } from "./rateLimit.js";

export interface McpConverseWalkInLocals {
  /** Set for a walk-in exchange so the service can name the caller without seeing the request. */
  mcpConverseSourceDigest: string;
}

interface McpConverseWalkInRateLimiterDependencies {
  env: Pick<Env,
    | "MCP_WALK_IN_RATE_LIMIT_WINDOW_MS"
    | "MCP_WALK_IN_SOURCE_RATE_LIMIT_MAX_ATTEMPTS"
    | "MCP_WALK_IN_AGENT_RATE_LIMIT_MAX_ATTEMPTS"
    | "MCP_WALK_IN_AGENT_BACKSTOP_MULTIPLIER"
    | "RADIOSO_MCP_SIGNING_SECRET"
    | "RADIOSO_TRUSTED_PROXY_HOPS"
  >;
  abuseControlService: PreAuthSourceAbuseControlPort;
  agentRepository: Pick<AgentRepositoryPort, "findByPublicId">;
  auditService: RateLimitAuditPort;
}

const walkInPublicId = (body: unknown): string | null => {
  if (!body || typeof body !== "object") {
    return null;
  }
  const candidate = (body as { publicId?: unknown }).publicId;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
};

/**
 * Three budgets on the credential-free exchange (FR-032), spent in widening order.
 *
 * The first is per calling source across every agent, as anonymous chat has. The second is
 * the operator's per-agent allowance **subdivided by source**: that subdivision is what
 * keeps a published agent usable, because a bare per-agent counter lets a handful of
 * abusive sources exhaust the whole allowance and lock every legitimate caller out for the
 * window (US4 AS-3). The third is the bare per-agent counter, kept only as a backstop an
 * order of magnitude above the per-source allowance, for the case of many sources at once.
 *
 * All three are spent before the exchange resolves anything about the agent, so a throttle
 * and a refusal are indistinguishable to a caller probing for agents that exist. The 429's
 * `Retry-After` and `RateLimit-*` headers come from the shared error handler; nothing here
 * writes a header.
 */
export const createMcpConverseWalkInRateLimiter = (
  dependencies: McpConverseWalkInRateLimiterDependencies,
  observer?: AgentConverseWalkInObserver,
): RequestHandler => async (req, res, next) => {
  const publicId = walkInPublicId(req.body);
  if (!publicId) {
    next();
    return;
  }

  const windowMs = dependencies.env.MCP_WALK_IN_RATE_LIMIT_WINDOW_MS;
  const sourceDigest = publishPreAuthSourceDigest(res, readPreAuthSourceDigest(res) ?? resolvedPreAuthSourceDigest(
    req,
    dependencies.env.RADIOSO_MCP_SIGNING_SECRET,
    dependencies.env.RADIOSO_TRUSTED_PROXY_HOPS,
  ));
  (res.locals as typeof res.locals & McpConverseWalkInLocals).mcpConverseSourceDigest = sourceDigest;

  let throttledAgentId: string | null = null;
  let throttledWorkspaceId: string | null = null;
  let spentScope = "mcp.converse.walkin.source";
  try {
    await dependencies.abuseControlService.enforce({
      scope: spentScope,
      subjectKey: `source:${sourceDigest}`,
      limit: dependencies.env.MCP_WALK_IN_SOURCE_RATE_LIMIT_MAX_ATTEMPTS,
      windowMs,
    });

    // An unknown id has no agent budget to spend; the source bucket above already bounds
    // what a flood of unknown ids can cost, and skipping here tells the caller nothing.
    const agent = await dependencies.agentRepository.findByPublicId(publicId);
    if (agent) {
      throttledAgentId = agent.id;
      throttledWorkspaceId = agent.workspaceId;
      const perSourceLimit = agent.walkInConversationsPerHour
        ?? dependencies.env.MCP_WALK_IN_AGENT_RATE_LIMIT_MAX_ATTEMPTS;
      spentScope = "mcp.converse.walkin.agent.source";
      await dependencies.abuseControlService.enforce({
        scope: spentScope,
        subjectKey: `agent:${agent.id}:source:${sourceDigest}`,
        limit: perSourceLimit,
        windowMs,
      });
      spentScope = "mcp.converse.walkin.agent";
      await dependencies.abuseControlService.enforce({
        scope: spentScope,
        subjectKey: `agent:${agent.id}`,
        limit: perSourceLimit * dependencies.env.MCP_WALK_IN_AGENT_BACKSTOP_MULTIPLIER,
        windowMs,
      });
    }
    next();
  } catch (error) {
    const statusCode = error && typeof error === "object" && "statusCode" in error
      ? (error as { statusCode?: unknown }).statusCode
      : undefined;
    if (statusCode === 429 || statusCode === 503) {
      // The security event feed is the operator's only view of a throttled walk-in
      // caller, and a direct `enforce` writes none of its own (US4 AS-3). The digest
      // names the caller; the public id stays out of it, as it does everywhere else.
      void dependencies.auditService.record({
        accountId: null,
        workspaceId: throttledWorkspaceId,
        eventType: statusCode === 429 ? "security.rate_limit_enforced" : "security.rate_limit_unavailable",
        eventStatus: statusCode === 429 ? "success" : "failure",
        metadata: {
          scope: spentScope,
          surface: "mcp_converse_walk_in",
          sourceDigest,
          ...(throttledAgentId ? { agentId: throttledAgentId } : {}),
        },
      }).catch(() => undefined);
    }
    if (statusCode === 429) {
      observer?.record({ outcome: "throttled", agentId: throttledAgentId, sourceDigest });
    }
    next(error);
  }
};
