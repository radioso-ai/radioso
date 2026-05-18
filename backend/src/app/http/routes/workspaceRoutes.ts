import { Router } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import { createRateLimitMiddleware } from "../middleware/rateLimit.js";
import { requireSession, type SessionDependencies } from "../middleware/requireSession.js";
import { requireWorkspaceSession, type WorkspaceSessionDependencies } from "../middleware/requireWorkspaceSession.js";
import { requireAccountPermission, requireWorkspacePermission } from "../middleware/requirePermission.js";
import { validateBody } from "../middleware/validate.js";

export const createWorkspaceSchema = z.object({
  name: z.string().min(1).max(100),
});

export const renameWorkspaceSchema = z.object({
  name: z.string().min(1).max(100),
});

export const workspaceParamsSchema = z.object({
  workspaceId: z.string().uuid(),
});

export const workspaceKeyParamsSchema = z.object({
  workspaceKey: z.string().trim().min(3).max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
});

type WorkspaceRouteDependencies = SessionDependencies & WorkspaceSessionDependencies & Pick<
  AppDependencies,
  "abuseControlService" | "auditService" | "workspaceService" | "workspaceSummaryService" | "accountRepository"
>;

export const createWorkspaceRoutes = (dependencies: WorkspaceRouteDependencies): Router => {
  const router = Router();
  const authenticatedUserSession = requireSession(dependencies, { requireActiveMembership: false });
  const workspaceSession = requireWorkspaceSession(dependencies);
  const workspaceMutationRateLimit = createRateLimitMiddleware({
    service: dependencies.abuseControlService,
    auditService: dependencies.auditService,
    scope: "workspace.mutation",
    limit: dependencies.env.WORKSPACE_RATE_LIMIT_MAX_ATTEMPTS,
    windowMs: dependencies.env.AUTH_RATE_LIMIT_WINDOW_MS,
    resolveSubjectKey: (_req, res) => String(res.locals.accountId ?? "unknown"),
    resolveAuditContext: (_req, res) => ({
      accountId: res.locals.accountId as string | undefined,
    }),
  });

  router.get("/", requireSession(dependencies), async (_req, res, next) => {
    try {
      const { accountId } = res.locals as { accountId: string };
      const workspaces = await dependencies.workspaceService.listForAccount(accountId);
      res.status(200).json({ workspaces });
    } catch (error) {
      next(error);
    }
  });

  router.get("/summary", workspaceSession, requireWorkspacePermission(dependencies, "workspace.summary.read"), async (_req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const summary = await dependencies.workspaceSummaryService.getSummary(workspaceId);
      res.status(200).json(summary);
    } catch (error) {
      next(error);
    }
  });

  router.get("/resolve/:workspaceKey", authenticatedUserSession, async (req, res, next) => {
    try {
      const { userId } = res.locals as { userId: string };
      const { workspaceKey } = workspaceKeyParamsSchema.parse(req.params);
      const workspace = await dependencies.workspaceService.resolveAccessibleByPublicRouteKey(userId, workspaceKey);
      const account = await dependencies.accountRepository.findById(workspace.accountId);
      res.status(200).json({
        workspaceKey: workspace.publicRouteKey,
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        accountId: workspace.accountId,
        organizationName: account?.name ?? "Organization",
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/", requireSession(dependencies), requireAccountPermission(dependencies, "workspace.create"), workspaceMutationRateLimit, validateBody(createWorkspaceSchema), async (req, res, next) => {
    try {
      const { accountId } = res.locals as { accountId: string };
      const workspace = await dependencies.workspaceService.create(accountId, req.body.name);
      res.status(201).json(workspace);
    } catch (error) {
      next(error);
    }
  });

  router.patch("/:workspaceId", requireSession(dependencies), requireWorkspacePermission(dependencies, "workspace.rename", (req) => String(req.params.workspaceId)), workspaceMutationRateLimit, validateBody(renameWorkspaceSchema), async (req, res, next) => {
    try {
      const { accountId } = res.locals as { accountId: string };
      const { workspaceId } = workspaceParamsSchema.parse(req.params);
      const workspace = await dependencies.workspaceService.rename(workspaceId, accountId, req.body.name);
      res.status(200).json(workspace);
    } catch (error) {
      next(error);
    }
  });

  router.delete("/:workspaceId", requireSession(dependencies), requireWorkspacePermission(dependencies, "workspace.delete", (req) => String(req.params.workspaceId)), workspaceMutationRateLimit, async (req, res, next) => {
    try {
      const { accountId } = res.locals as { accountId: string };
      const { workspaceId } = workspaceParamsSchema.parse(req.params);
      await dependencies.workspaceService.delete(workspaceId, accountId);
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  return router;
};
