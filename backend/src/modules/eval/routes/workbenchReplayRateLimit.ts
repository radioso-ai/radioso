import type { RequestHandler } from "express";

import type { AuditService } from "../../audit/contracts/index.js";
import { createRateLimitMiddleware, type RateLimitAbuseControlPort } from "../../../app/http/middleware/rateLimit.js";

export const WORKBENCH_REPLAY_RATE_LIMIT = {
  scope: "eval.workbench_replay",
  limit: 10,
  windowMs: 3_600_000,
  blockMs: 60_000,
} as const;

export interface WorkbenchReplayRateLimitDependencies {
  abuseControlService: RateLimitAbuseControlPort;
  auditService: AuditService;
}

const hasWorkbenchReplayOverride = (body: unknown): boolean => {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return false;
  }
  const record = body as {
    agentConfigOverride?: unknown;
    overrides?: { agentConfigOverride?: unknown; routineStartState?: unknown };
  };
  return Boolean(
    record.agentConfigOverride
      || record.overrides?.agentConfigOverride
      || record.overrides?.routineStartState,
  );
};

export const workbenchReplayRateLimiter = (
  dependencies: WorkbenchReplayRateLimitDependencies,
): RequestHandler =>
  createRateLimitMiddleware({
    service: dependencies.abuseControlService,
    auditService: dependencies.auditService,
    scope: WORKBENCH_REPLAY_RATE_LIMIT.scope,
    limit: WORKBENCH_REPLAY_RATE_LIMIT.limit,
    windowMs: WORKBENCH_REPLAY_RATE_LIMIT.windowMs,
    blockMs: WORKBENCH_REPLAY_RATE_LIMIT.blockMs,
    resolveSubjectKey: (req, res) => {
      if (!hasWorkbenchReplayOverride(req.body)) {
        return null;
      }
      const { workspaceId } = res.locals as { workspaceId?: string };
      return workspaceId ? `workspace:${workspaceId}` : null;
    },
    resolveAuditContext: (req, res) => {
      const locals = res.locals as {
        accountId?: string;
        authMode?: string;
        authPrincipal?: { type?: string };
        workspaceId?: string;
      };
      return {
        accountId: locals.accountId ?? null,
        workspaceId: locals.workspaceId ?? null,
        metadata: {
          authMode: locals.authMode,
          principalType: locals.authPrincipal?.type,
          route: `${req.baseUrl}${req.path}`,
        },
      };
    },
  });
