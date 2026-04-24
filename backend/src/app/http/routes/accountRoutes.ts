import { Router } from "express";

import type { AppDependencies } from "../../server/types.js";
import { workspaceParamsSchema } from "./workspaceRoutes.js";
import { createRateLimitMiddleware } from "../middleware/rateLimit.js";
import { requireSession } from "../middleware/requireSession.js";
import { badRequest } from "../../../shared/domain/errors.js";

export const createAccountRoutes = (dependencies: AppDependencies): Router => {
  const router = Router();
  const requireAuthenticatedSession = requireSession(dependencies);
  const workspaceTokenReadRateLimit = createRateLimitMiddleware({
    service: dependencies.abuseControlService,
    auditService: dependencies.auditService,
    scope: "auth.token.read",
    limit: Math.min(dependencies.env.AUTH_RATE_LIMIT_MAX_ATTEMPTS, 5),
    windowMs: dependencies.env.AUTH_RATE_LIMIT_WINDOW_MS,
    resolveSubjectKey: (_req, res) => {
      const { accountId } = res.locals as { accountId?: string };
      const workspaceId = typeof _req.params.workspaceId === "string" ? _req.params.workspaceId : null;
      return accountId && workspaceId ? `${accountId}:${workspaceId}` : accountId ?? null;
    },
    resolveAuditContext: (req, res) => {
      const { accountId } = res.locals as { accountId?: string };
      return {
        accountId: accountId ?? null,
        workspaceId: typeof req.params.workspaceId === "string" ? req.params.workspaceId : null,
      };
    },
  });
  const workspaceTokenRotateRateLimit = createRateLimitMiddleware({
    service: dependencies.abuseControlService,
    auditService: dependencies.auditService,
    scope: "auth.token.rotate",
    limit: Math.min(dependencies.env.AUTH_RATE_LIMIT_MAX_ATTEMPTS, 3),
    windowMs: dependencies.env.AUTH_RATE_LIMIT_WINDOW_MS,
    resolveSubjectKey: (_req, res) => {
      const { accountId } = res.locals as { accountId?: string };
      const workspaceId = typeof _req.params.workspaceId === "string" ? _req.params.workspaceId : null;
      return accountId && workspaceId ? `${accountId}:${workspaceId}` : accountId ?? null;
    },
    resolveAuditContext: (req, res) => {
      const { accountId } = res.locals as { accountId?: string };
      return {
        accountId: accountId ?? null,
        workspaceId: typeof req.params.workspaceId === "string" ? req.params.workspaceId : null,
      };
    },
  });

  router.get("/workspaces/:workspaceId/token", requireAuthenticatedSession, workspaceTokenReadRateLimit, async (req, res, next) => {
    try {
      const parsedParams = workspaceParamsSchema.safeParse(req.params);
      if (!parsedParams.success) {
        throw badRequest("Invalid workspace id", parsedParams.error.flatten());
      }

      const { accountId } = res.locals as { accountId: string };
      const result = await dependencies.authService.getTokenForWorkspace(parsedParams.data.workspaceId, accountId);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post("/workspaces/:workspaceId/token/rotate", requireAuthenticatedSession, workspaceTokenRotateRateLimit, async (req, res, next) => {
    try {
      const parsedParams = workspaceParamsSchema.safeParse(req.params);
      if (!parsedParams.success) {
        throw badRequest("Invalid workspace id", parsedParams.error.flatten());
      }

      const { accountId } = res.locals as { accountId: string };
      const result = await dependencies.authService.rotateTokenForWorkspace(parsedParams.data.workspaceId, accountId);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
};
