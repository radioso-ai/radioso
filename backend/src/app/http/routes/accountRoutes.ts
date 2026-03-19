import { Router } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import { requireSession } from "../middleware/requireSession.js";

const workspaceParamsSchema = z.object({
  workspaceId: z.string().uuid(),
});

const usageQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).optional(),
  months: z.coerce.number().int().min(1).max(24).optional(),
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

  router.get("/usage", requireSession(dependencies), async (req, res, next) => {
    try {
      const { accountId } = res.locals as { accountId: string };
      const query = usageQuerySchema.parse(req.query);
      const usage = await dependencies.usageSummaryService.getAccountUsageSummary({
        accountId,
        days: query.days,
        months: query.months,
      });
      res.status(200).json(usage);
    } catch (error) {
      next(error);
    }
  });

  return router;
};
