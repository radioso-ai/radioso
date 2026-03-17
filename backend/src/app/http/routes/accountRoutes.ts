import { Router } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import { requireSession } from "../middleware/requireSession.js";

const workspaceParamsSchema = z.object({
  workspaceId: z.string().uuid(),
});

export const createAccountRoutes = (dependencies: AppDependencies): Router => {
  const router = Router();

  router.get("/workspaces/:workspaceId/token", requireSession(dependencies), async (req, res, next) => {
    try {
      const { accountId } = res.locals as { accountId: string };
      const { workspaceId } = workspaceParamsSchema.parse(req.params);
      const result = await dependencies.authService.getTokenForWorkspace(workspaceId, accountId);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
};
