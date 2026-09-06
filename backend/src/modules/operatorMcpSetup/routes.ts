import { Router } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../app/server/types.js";
import { forbidden } from "../../shared/domain/errors.js";
import { requireDashboardWorkspaceSession } from "../../app/http/middleware/requireDashboardWorkspaceSession.js";
import { buildOperatorMcpSetup } from "./setupArtifacts.js";
import { operatorMcpRolloutWorkspaceIds } from "../operatorMcpAuthorization/public.js";

type Dependencies = Pick<AppDependencies, "env" | "authService" | "accountAccessService" | "workspaceSessionService" | "operatorMcpReadiness">;
const paramsSchema = z.object({ workspaceId: z.string().uuid() });

export const createOperatorMcpSetupRoutes = (dependencies: Dependencies): Router => {
  const router = Router();
  const dashboardSession = requireDashboardWorkspaceSession(dependencies);
  router.get("/workspaces/:workspaceId/operator-mcp/setup", dashboardSession, async (req, res, next) => {
    try {
      const { workspaceId } = paramsSchema.parse(req.params);
      if (workspaceId !== (res.locals as { workspaceId?: string }).workspaceId) throw forbidden();
      const rolloutWorkspaceIds = operatorMcpRolloutWorkspaceIds(dependencies.env.OPERATOR_MCP_ROLLOUT_WORKSPACE_IDS);
      res.status(200).json(buildOperatorMcpSetup({
        enabled: dependencies.env.OPERATOR_MCP_ENABLED === true,
        resource: dependencies.env.OPERATOR_MCP_RESOURCE_URL,
        ready: rolloutWorkspaceIds.has(workspaceId) && await dependencies.operatorMcpReadiness,
        now: new Date(),
      }));
    } catch (error) {
      next(error);
    }
  });
  return router;
};
