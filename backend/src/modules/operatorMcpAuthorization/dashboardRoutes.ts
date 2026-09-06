import { Router } from "express";
import { z } from "zod";

import { requireApiAccessCsrf } from "../../app/http/middleware/requireApiAccessCsrf.js";
import { requireDashboardWorkspaceSession } from "../../app/http/middleware/requireDashboardWorkspaceSession.js";
import type { AppDependencies } from "../../app/server/types.js";
import { forbidden } from "../../shared/domain/errors.js";

type Dependencies = Pick<AppDependencies,
  "env" | "authService" | "accountAccessService" | "workspaceSessionService" | "operatorMcpGrantService"
>;
const workspaceParams = z.object({ workspaceId: z.string().uuid() });
const grantParams = workspaceParams.extend({ grantId: z.string().uuid() });

const actor = (res: { locals: Record<string, unknown> }, workspaceId: string) => {
  const locals = res.locals as { accountId?: string; userId?: string; workspaceId?: string };
  if (!locals.accountId || !locals.userId || locals.workspaceId !== workspaceId) throw forbidden();
  return { accountId: locals.accountId, actorUserId: locals.userId, workspaceId };
};

export const createOperatorMcpDashboardRoutes = (dependencies: Dependencies): Router => {
  const router = Router();
  const dashboardSession = requireDashboardWorkspaceSession(dependencies);
  router.get("/workspaces/:workspaceId/operator-mcp/grants", dashboardSession, async (req, res, next) => {
    try {
      const { workspaceId } = workspaceParams.parse(req.params);
      res.status(200).json(await dependencies.operatorMcpGrantService.list(actor(res, workspaceId)));
    } catch (error) { next(error); }
  });
  router.get("/workspaces/:workspaceId/operator-mcp/grants/:grantId", dashboardSession, async (req, res, next) => {
    try {
      const { workspaceId, grantId } = grantParams.parse(req.params);
      res.status(200).json(await dependencies.operatorMcpGrantService.get({ ...actor(res, workspaceId), grantId }));
    } catch (error) { next(error); }
  });
  router.post("/workspaces/:workspaceId/operator-mcp/grants/:grantId/revoke", dashboardSession, requireApiAccessCsrf, async (req, res, next) => {
    try {
      const { workspaceId, grantId } = grantParams.parse(req.params);
      res.status(200).json(await dependencies.operatorMcpGrantService.revoke({ ...actor(res, workspaceId), grantId, now: new Date() }));
    } catch (error) { next(error); }
  });
  return router;
};
