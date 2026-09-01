import type { RequestHandler, Response } from "express";

import type { Env } from "../../config/env.js";
import {
  createRateLimitBatchMiddleware,
  type RateLimitAuditPort,
  type RateLimitBatchAbuseControlPort,
} from "./rateLimit.js";
import { createPreAuthSourceRateLimiter } from "./preAuthSourceRateLimiter.js";

export interface AgentChannelRateLimiterDependencies {
  env: Pick<Env,
    | "AGENT_CHANNEL_CHAT_RATE_LIMIT_WINDOW_MS"
    | "AGENT_CHANNEL_CHAT_SOURCE_RATE_LIMIT_MAX_ATTEMPTS"
    | "AGENT_CHANNEL_CHAT_GRANT_RATE_LIMIT_MAX_ATTEMPTS"
    | "AGENT_CHANNEL_CHAT_WORKSPACE_RATE_LIMIT_MAX_ATTEMPTS"
    | "RADIOSO_TRUSTED_PROXY_HOPS"
  >;
  abuseControlService: RateLimitBatchAbuseControlPort & {
    enforce(input: { scope: string; subjectKey: string; limit: number; windowMs: number }): Promise<unknown>;
  };
  auditService: RateLimitAuditPort;
}

type AgentChannelAudience = "mcp" | "rest";

type ChannelGrantIdentity = {
  grantId: string;
  workspaceId: string;
  agentId: string;
};

const identityForAudience = (res: Response, audience: AgentChannelAudience): ChannelGrantIdentity | null => {
  if (audience === "rest") {
    const grant = res.locals.agentChannelGrant as {
      id?: string;
      workspaceId?: string;
      agentId?: string;
    } | undefined;
    if (!grant?.id || !grant.workspaceId || !grant.agentId) return null;
    return { grantId: grant.id, workspaceId: grant.workspaceId, agentId: grant.agentId };
  }

  const principal = res.locals.mcpConversePrincipal as {
    grantId?: string;
    workspaceId?: string;
    agentId?: string;
  } | undefined;
  if (!principal?.grantId || !principal.workspaceId || !principal.agentId) return null;
  return { grantId: principal.grantId, workspaceId: principal.workspaceId, agentId: principal.agentId };
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
          subjectKey: `grant:${identity.grantId}`,
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
