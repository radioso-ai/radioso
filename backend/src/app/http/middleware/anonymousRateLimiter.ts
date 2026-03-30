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
    resolveSubjectKey: (_req, res) => {
      const sessionId = res.locals.anonymousSessionId as string | undefined;
      const workspaceId = res.locals.workspaceId as string | undefined;
      if (!sessionId || !workspaceId) {
        return null;
      }
      return `${workspaceId}:${sessionId}`;
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
