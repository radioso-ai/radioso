import type { RequestHandler } from "express";

import { createRateLimitMiddleware } from "./rateLimit.js";
import type { AppDependencies } from "../../server/types.js";

export const AUDIENCE_PULSE_REFRESH_RATE_LIMIT_SCOPE = "audience_pulse.refresh";

export type AudiencePulseRefreshRateLimitDependencies = Pick<
  AppDependencies,
  "env" | "abuseControlService" | "auditService"
>;

/** Durable account/workspace budget for explicit provider-backed report refreshes. */
export const createAudiencePulseRefreshRateLimiter = (
  dependencies: AudiencePulseRefreshRateLimitDependencies,
): RequestHandler => createRateLimitMiddleware({
  service: dependencies.abuseControlService,
  auditService: dependencies.auditService,
  scope: AUDIENCE_PULSE_REFRESH_RATE_LIMIT_SCOPE,
  limit: dependencies.env.AUDIENCE_PULSE_REFRESH_RATE_LIMIT_MAX_ATTEMPTS,
  windowMs: dependencies.env.AUDIENCE_PULSE_REFRESH_RATE_LIMIT_WINDOW_MS,
  resolveSubjectKey: (_req, res) => {
    const { accountId, workspaceId } = res.locals as { accountId?: string; workspaceId?: string };
    return accountId && workspaceId ? `${accountId}:${workspaceId}` : null;
  },
  resolveAuditContext: (_req, res) => {
    const { accountId, workspaceId } = res.locals as { accountId?: string; workspaceId?: string };
    return { accountId, workspaceId };
  },
});
