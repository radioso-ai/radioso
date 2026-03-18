import { Router } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import { requireSession } from "../middleware/requireSession.js";
import { validateBody } from "../middleware/validate.js";

const createWorkspaceSchema = z.object({
  name: z.string().min(1).max(100),
});

const renameWorkspaceSchema = z.object({
  name: z.string().min(1).max(100),
});

const workspaceParamsSchema = z.object({
  workspaceId: z.string().uuid(),
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

  router.patch("/:workspaceId", requireSession(dependencies), validateBody(renameWorkspaceSchema), async (req, res, next) => {
    try {
      const { accountId } = res.locals as { accountId: string };
      const { workspaceId } = workspaceParamsSchema.parse(req.params);
      const workspace = await dependencies.workspaceService.rename(workspaceId, accountId, req.body.name);
      res.status(200).json(workspace);
    } catch (error) {
      next(error);
    }
  });

  router.delete("/:workspaceId", requireSession(dependencies), async (req, res, next) => {
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
