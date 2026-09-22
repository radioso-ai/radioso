import type { RequestHandler } from "express";

import type { AgentRepositoryPort } from "../../../db/repositories/agentRepository.js";
import type { AgentConverseWalkInObserver } from "../../../modules/settings/contracts/agentConverseSession.js";
import type { Env } from "../../config/env.js";
import {
  resolvedPreAuthSourceDigest,
  type PreAuthSourceAbuseControlPort,
} from "./preAuthSourceRateLimiter.js";

export interface McpConverseWalkInLocals {
  /** Set for a walk-in exchange so the service can name the caller without seeing the request. */
  mcpConverseSourceDigest: string;
}

interface McpConverseWalkInRateLimiterDependencies {
  env: Pick<Env,
    | "MCP_WALK_IN_RATE_LIMIT_WINDOW_MS"
    | "MCP_WALK_IN_SOURCE_RATE_LIMIT_MAX_ATTEMPTS"
    | "MCP_WALK_IN_AGENT_RATE_LIMIT_MAX_ATTEMPTS"
    | "RADIOSO_MCP_SIGNING_SECRET"
    | "RADIOSO_TRUSTED_PROXY_HOPS"
  >;
  abuseControlService: PreAuthSourceAbuseControlPort;
  agentRepository: Pick<AgentRepositoryPort, "findByPublicId">;
}

const walkInPublicId = (body: unknown): string | null => {
  if (!body || typeof body !== "object") {
    return null;
  }
  const candidate = (body as { publicId?: unknown }).publicId;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
};

/**
 * Two budgets on the credential-free exchange: one per calling source, as anonymous chat
 * has, and one per agent, which is what stops a single looping caller from spending the
 * workspace's conversation allowance (FR-032).
 *
 * Both are spent before the exchange resolves anything about the agent, so a throttle and
 * a refusal are indistinguishable to a caller probing for agents that exist. The 429's
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
  const sourceDigest = resolvedPreAuthSourceDigest(
    req,
    dependencies.env.RADIOSO_MCP_SIGNING_SECRET,
    dependencies.env.RADIOSO_TRUSTED_PROXY_HOPS,
  );
  (res.locals as typeof res.locals & McpConverseWalkInLocals).mcpConverseSourceDigest = sourceDigest;

  let throttledAgentId: string | null = null;
  try {
    await dependencies.abuseControlService.enforce({
      scope: "mcp.converse.walkin.source",
      subjectKey: `source:${sourceDigest}`,
      limit: dependencies.env.MCP_WALK_IN_SOURCE_RATE_LIMIT_MAX_ATTEMPTS,
      windowMs,
    });

    // An unknown id has no agent budget to spend; the source bucket above already bounds
    // what a flood of unknown ids can cost, and skipping here tells the caller nothing.
    const agent = await dependencies.agentRepository.findByPublicId(publicId);
    if (agent) {
      throttledAgentId = agent.id;
      await dependencies.abuseControlService.enforce({
        scope: "mcp.converse.walkin.agent",
        subjectKey: `agent:${agent.id}`,
        limit: agent.walkInConversationsPerHour ?? dependencies.env.MCP_WALK_IN_AGENT_RATE_LIMIT_MAX_ATTEMPTS,
        windowMs,
      });
    }
    next();
  } catch (error) {
    const statusCode = error && typeof error === "object" && "statusCode" in error
      ? (error as { statusCode?: unknown }).statusCode
      : undefined;
    if (statusCode === 429) {
      observer?.record({ outcome: "throttled", agentId: throttledAgentId, sourceDigest });
    }
    next(error);
  }
};
