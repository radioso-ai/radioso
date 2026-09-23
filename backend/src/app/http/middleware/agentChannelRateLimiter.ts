import type { RequestHandler, Response } from "express";

import type { AgentConversePrincipal } from "../../../modules/settings/contracts/agentConverseSession.js";
import type { Env } from "../../config/env.js";
import {
  createRateLimitBatchMiddleware,
  type RateLimitAuditPort,
  type RateLimitBatchAbuseControlPort,
} from "./rateLimit.js";
import {
  createPreAuthSourceRateLimiter,
  readPreAuthSourceDigest,
  type PreAuthSourceAbuseControlPort,
} from "./preAuthSourceRateLimiter.js";

export interface AgentChannelRateLimiterDependencies {
  env: Pick<Env,
    | "AGENT_CHANNEL_CHAT_RATE_LIMIT_WINDOW_MS"
    | "AGENT_CHANNEL_CHAT_SOURCE_RATE_LIMIT_MAX_ATTEMPTS"
    | "AGENT_CHANNEL_CHAT_GRANT_RATE_LIMIT_MAX_ATTEMPTS"
    | "AGENT_CHANNEL_CHAT_WORKSPACE_RATE_LIMIT_MAX_ATTEMPTS"
    | "RADIOSO_TRUSTED_PROXY_HOPS"
  >;
  abuseControlService: RateLimitBatchAbuseControlPort & PreAuthSourceAbuseControlPort;
  auditService: RateLimitAuditPort;
}

type AgentChannelAudience = "mcp" | "rest";

type ChannelCallerIdentity = {
  /** Already prefixed: the per-caller turn budget is spent under this exact key. */
  callerKey: string;
  workspaceId: string;
  agentId: string;
};

const identityForAudience = (res: Response, audience: AgentChannelAudience): ChannelCallerIdentity | null => {
  if (audience === "rest") {
    const grant = res.locals.agentChannelGrant as {
      id?: string;
      workspaceId?: string;
      agentId?: string;
    } | undefined;
    if (!grant?.id || !grant.workspaceId || !grant.agentId) return null;
    return { callerKey: `grant:${grant.id}`, workspaceId: grant.workspaceId, agentId: grant.agentId };
  }

  const principal = res.locals.mcpConversePrincipal as AgentConversePrincipal | undefined;
  if (!principal?.origin || !principal.workspaceId || !principal.agentId) return null;
  // A walk-in caller has no credential to charge. Keying on its session id would have made
  // the budget free to reset — a caller simply exchanges a new session — so the subject is
  // the agent's public id and the calling source, which is the same pair the walk-in
  // exchange budgets. Callers sharing one egress address share one turn budget, as they
  // already share the exchange budget.
  const callerKey = principal.origin.kind === "grant"
    ? `grant:${principal.origin.grantId}`
    : `walkin:${principal.origin.publicId}:${readPreAuthSourceDigest(res) ?? principal.publicSessionId}`;
  return { callerKey, workspaceId: principal.workspaceId, agentId: principal.agentId };
};

/**
 * Shared durable budget for costly agent turns. A credential may have its own
 * budget, but all credentials in a workspace also spend the workspace budget.
 */
export const agentChannelChatRateLimiters = (
  dependencies: AgentChannelRateLimiterDependencies,
  audience: AgentChannelAudience,
): RequestHandler[] => [
  createRateLimitBatchMiddleware({
    service: dependencies.abuseControlService,
    auditService: dependencies.auditService,
    resolvePolicies: (_req, res) => {
      const identity = identityForAudience(res, audience);
      if (!identity) return [];
      return [
        {
          scope: "agent.channel.chat.grant",
          subjectKey: identity.callerKey,
          limit: dependencies.env.AGENT_CHANNEL_CHAT_GRANT_RATE_LIMIT_MAX_ATTEMPTS,
          windowMs: dependencies.env.AGENT_CHANNEL_CHAT_RATE_LIMIT_WINDOW_MS,
        },
        {
          scope: "agent.channel.chat.workspace",
          subjectKey: `workspace:${identity.workspaceId}:global`,
          limit: dependencies.env.AGENT_CHANNEL_CHAT_WORKSPACE_RATE_LIMIT_MAX_ATTEMPTS,
          windowMs: dependencies.env.AGENT_CHANNEL_CHAT_RATE_LIMIT_WINDOW_MS,
        },
      ];
    },
    resolveAuditContext: (_req, res) => {
      const identity = identityForAudience(res, audience);
      return identity ? {
        workspaceId: identity.workspaceId,
        metadata: { audience, agentId: identity.agentId },
      } : {};
    },
  }),
];

export const createAgentChannelSourceRateLimiter = (
  dependencies: AgentChannelRateLimiterDependencies,
): RequestHandler => createPreAuthSourceRateLimiter({
  service: dependencies.abuseControlService,
  scope: "agent.channel.chat.source",
  limit: dependencies.env.AGENT_CHANNEL_CHAT_SOURCE_RATE_LIMIT_MAX_ATTEMPTS,
  trustedProxyHops: dependencies.env.RADIOSO_TRUSTED_PROXY_HOPS,
  windowMs: dependencies.env.AGENT_CHANNEL_CHAT_RATE_LIMIT_WINDOW_MS,
});
