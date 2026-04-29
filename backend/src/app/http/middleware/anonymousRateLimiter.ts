import type { RequestHandler } from "express";

import type { AppDependencies } from "../../server/types.js";
import { createRateLimitMiddleware } from "./rateLimit.js";

export const anonymousRateLimiter = (dependencies: AppDependencies): RequestHandler =>
  createRateLimitMiddleware({
    service: dependencies.abuseControlService,
    auditService: dependencies.auditService,
    scope: "anonymous.chat",
    limit: (_req, res) => (res.locals.anonymousRateLimit as number | undefined) ?? 10,
    windowMs: dependencies.env.AUTH_RATE_LIMIT_WINDOW_MS,
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
  });

export const resetRateLimiterState = () => {
  // Durable abuse control state is reset by test repository setup, so this is now a no-op.
};
