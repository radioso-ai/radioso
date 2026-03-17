import { Router } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import { requireSession } from "../middleware/requireSession.js";
import { validateBody } from "../middleware/validate.js";

const createWorkspaceSchema = z.object({
  name: z.string().min(1).max(100),
});

export const createWorkspaceRoutes = (dependencies: AppDependencies): Router => {
  const router = Router();

  router.get("/", requireSession(dependencies), async (_req, res, next) => {
    try {
      const { accountId } = res.locals as { accountId: string };
      const workspaces = await dependencies.workspaceService.listForAccount(accountId);
      res.status(200).json({ workspaces });
    } catch (error) {
      next(error);
    }
  });

  router.post("/", requireSession(dependencies), validateBody(createWorkspaceSchema), async (req, res, next) => {
    try {
      const { accountId } = res.locals as { accountId: string };
      const workspace = await dependencies.workspaceService.create(accountId, req.body.name);
      res.status(201).json(workspace);
    } catch (error) {
      next(error);
    }
  });

  return router;
};
