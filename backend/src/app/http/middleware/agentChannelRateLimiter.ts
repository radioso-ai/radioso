import type { RequestHandler, Response } from "express";

import type { Env } from "../../config/env.js";
import {
  createRateLimitMiddleware,
  type RateLimitAbuseControlPort,
  type RateLimitAuditPort,
} from "./rateLimit.js";

export interface AgentChannelRateLimiterDependencies {
  env: Pick<Env,
    | "AGENT_CHANNEL_CHAT_RATE_LIMIT_WINDOW_MS"
    | "AGENT_CHANNEL_CHAT_GRANT_RATE_LIMIT_MAX_ATTEMPTS"
    | "AGENT_CHANNEL_CHAT_WORKSPACE_RATE_LIMIT_MAX_ATTEMPTS"
  >;
  abuseControlService: RateLimitAbuseControlPort;
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
  createRateLimitMiddleware({
    service: dependencies.abuseControlService,
    auditService: dependencies.auditService,
    scope: "agent.channel.chat.grant",
    limit: dependencies.env.AGENT_CHANNEL_CHAT_GRANT_RATE_LIMIT_MAX_ATTEMPTS,
    windowMs: dependencies.env.AGENT_CHANNEL_CHAT_RATE_LIMIT_WINDOW_MS,
    resolveSubjectKey: (_req, res) => {
      const identity = identityForAudience(res, audience);
      return identity ? `grant:${identity.grantId}` : null;
    },
    resolveAuditContext: (_req, res) => {
      const identity = identityForAudience(res, audience);
      return identity ? {
        workspaceId: identity.workspaceId,
        metadata: { audience, agentId: identity.agentId },
      } : {};
    },
  }),
  createRateLimitMiddleware({
    service: dependencies.abuseControlService,
    auditService: dependencies.auditService,
    scope: "agent.channel.chat.workspace",
    limit: dependencies.env.AGENT_CHANNEL_CHAT_WORKSPACE_RATE_LIMIT_MAX_ATTEMPTS,
    windowMs: dependencies.env.AGENT_CHANNEL_CHAT_RATE_LIMIT_WINDOW_MS,
    resolveSubjectKey: (_req, res) => {
      const identity = identityForAudience(res, audience);
      return identity ? `workspace:${identity.workspaceId}:global` : null;
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
