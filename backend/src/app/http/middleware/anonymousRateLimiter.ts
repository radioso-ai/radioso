import type { RequestHandler } from "express";

import type { AppDependencies } from "../../server/types.js";
import { createRateLimitMiddleware } from "./rateLimit.js";

export type AnonymousRateLimiterDependencies = Pick<AppDependencies, "env" | "abuseControlService" | "auditService">;

export const anonymousRateLimiters = (dependencies: AnonymousRateLimiterDependencies): RequestHandler[] => [
  createRateLimitMiddleware({
    service: dependencies.abuseControlService,
    auditService: dependencies.auditService,
    scope: "public.chat.session",
    limit: dependencies.env.PUBLIC_CHAT_SESSION_RATE_LIMIT_MAX_ATTEMPTS,
    windowMs: dependencies.env.PUBLIC_CHAT_RATE_LIMIT_WINDOW_MS,
    resolveSubjectKey: (req, res) => {
      const workspaceId = res.locals.workspaceId as string | undefined;
      if (!workspaceId) {
        return null;
      }

      const rateLimitId = res.locals.anonymousRateLimitId as string | undefined;
      if (rateLimitId && res.locals.anonymousRateLimitIdFromCookie === true) {
        return `${workspaceId}:browser:${rateLimitId}`;
      }

      const requestSource = req.ip || req.socket.remoteAddress || "unknown";
      return `${workspaceId}:source:${requestSource}`;
    },
    resolveAuditContext: (_req, res) => ({
      workspaceId: res.locals.workspaceId as string | undefined,
      metadata: {
        anonymousSessionId: res.locals.anonymousSessionId as string | undefined,
      },
    }),
  }),
  createRateLimitMiddleware({
    service: dependencies.abuseControlService,
    auditService: dependencies.auditService,
    scope: "public.chat.global",
    limit: dependencies.env.PUBLIC_CHAT_GLOBAL_RATE_LIMIT_MAX_ATTEMPTS,
    windowMs: dependencies.env.PUBLIC_CHAT_RATE_LIMIT_WINDOW_MS,
    resolveSubjectKey: (_req, res) => {
      const workspaceId = res.locals.workspaceId as string | undefined;
      return workspaceId ? `${workspaceId}:global` : null;
    },
    resolveAuditContext: (_req, res) => ({
      workspaceId: res.locals.workspaceId as string | undefined,
      metadata: {
        anonymousSessionId: res.locals.anonymousSessionId as string | undefined,
      },
    }),
  }),
];

export const resetRateLimiterState = () => {
  // Durable abuse control state is reset by test repository setup, so this is now a no-op.
};
