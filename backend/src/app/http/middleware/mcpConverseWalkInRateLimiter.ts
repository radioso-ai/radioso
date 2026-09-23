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

/**
 * An hour. Opening a conversation is the expensive act here, and an hour is the span an
 * operator reasons about when they set an agent's own `walkInConversationsPerHour`.
 */
const WALK_IN_WINDOW_MS = 60 * 60 * 1000;

/**
 * New conversations one calling source may open across every agent in the window. A
 * legitimate client opens one conversation and keeps talking in it, so twenty an hour is
 * generous for real use and cheap to exhaust by looping.
 */
const WALK_IN_SOURCE_LIMIT = 20;

/**
 * New conversations one calling source may open on one agent, when the operator has not
 * set the agent's own `walkInConversationsPerHour`. That column is the tuning lever; this
 * is the number an agent gets until someone moves it.
 */
const WALK_IN_AGENT_SOURCE_LIMIT = 60;

/**
 * How far the bare per-agent counter sits above the per-source allowance. It is a backstop
 * for many sources at once rather than the everyday budget, so it has to be high enough
 * that a handful of abusive callers cannot reach it and lock everyone else out.
 */
const WALK_IN_AGENT_BACKSTOP_MULTIPLIER = 10;

interface McpConverseWalkInRateLimiterDependencies {
  env: Pick<Env,
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
      limit: WALK_IN_SOURCE_LIMIT,
      windowMs: WALK_IN_WINDOW_MS,
    });

    // An unknown id has no agent budget to spend; the source bucket above already bounds
    // what a flood of unknown ids can cost, and skipping here tells the caller nothing.
    const agent = await dependencies.agentRepository.findByPublicId(publicId);
    if (agent) {
      throttledAgentId = agent.id;
      throttledWorkspaceId = agent.workspaceId;
      const perSourceLimit = agent.walkInConversationsPerHour ?? WALK_IN_AGENT_SOURCE_LIMIT;
      spentScope = "mcp.converse.walkin.agent.source";
      await dependencies.abuseControlService.enforce({
        scope: spentScope,
        subjectKey: `agent:${agent.id}:source:${sourceDigest}`,
        limit: perSourceLimit,
        windowMs: WALK_IN_WINDOW_MS,
      });
      spentScope = "mcp.converse.walkin.agent";
      await dependencies.abuseControlService.enforce({
        scope: spentScope,
        subjectKey: `agent:${agent.id}`,
        limit: perSourceLimit * WALK_IN_AGENT_BACKSTOP_MULTIPLIER,
        windowMs: WALK_IN_WINDOW_MS,
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
