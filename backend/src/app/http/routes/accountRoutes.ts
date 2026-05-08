import { Router } from "express";

import type { AppDependencies } from "../../server/types.js";
import { workspaceParamsSchema } from "./workspaceRoutes.js";
import { createRateLimitMiddleware } from "../middleware/rateLimit.js";
import { requireSession, type SessionDependencies } from "../middleware/requireSession.js";
import { requireWorkspacePermission } from "../middleware/requirePermission.js";
import { badRequest } from "../../../shared/domain/errors.js";

type AccountRouteDependencies = SessionDependencies & Pick<AppDependencies, "abuseControlService" | "auditService">;

const requireWorkspaceIdParam = (params: unknown): string => {
  const parsedParams = workspaceParamsSchema.safeParse(params);
  if (!parsedParams.success) {
    throw badRequest("Invalid workspace id", parsedParams.error.flatten());
  }

  return parsedParams.data.workspaceId;
};

export const createAccountRoutes = (dependencies: AccountRouteDependencies): Router => {
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

  router.get(
    "/workspaces/:workspaceId/token",
    requireAuthenticatedSession,
    requireWorkspacePermission(dependencies, "workspace.token.read", (req) => requireWorkspaceIdParam(req.params)),
    workspaceTokenReadRateLimit,
    async (req, res, next) => {
      try {
        const { accountId } = res.locals as { accountId: string };
        const result = await dependencies.authService.getTokenForWorkspace(requireWorkspaceIdParam(req.params), accountId);
        res.status(200).json(result);
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/workspaces/:workspaceId/token/rotate",
    requireAuthenticatedSession,
    requireWorkspacePermission(dependencies, "workspace.token.rotate", (req) => requireWorkspaceIdParam(req.params)),
    workspaceTokenRotateRateLimit,
    async (req, res, next) => {
      try {
        const { accountId } = res.locals as { accountId: string };
        const result = await dependencies.authService.rotateTokenForWorkspace(requireWorkspaceIdParam(req.params), accountId);
        res.status(200).json(result);
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
};
