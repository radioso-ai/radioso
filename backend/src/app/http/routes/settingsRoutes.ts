import { Router } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import { requireApiToken } from "../middleware/requireApiToken.js";
import { validateBody } from "../middleware/validate.js";

const updateSettingsSchema = z.object({
  queryRewriteEnabled: z.boolean(),
  rerankEnabled: z.boolean(),
  vectorTopK: z.number().int(),
  similarityThreshold: z.number(),
  rerankTopK: z.number().int(),
});

export const createSettingsRoutes = (dependencies: AppDependencies): Router => {
  const router = Router();

  router.get("/retrieval", requireApiToken(dependencies), async (_req, res, next) => {
    try {
      const { accountId } = res.locals as { accountId: string };
      const settings = await dependencies.retrievalSettingsService.getForAccount(accountId);
      res.status(200).json(settings);
    } catch (error) {
      next(error);
    }
  });

  router.put("/retrieval", requireApiToken(dependencies), validateBody(updateSettingsSchema), async (req, res, next) => {
    try {
      const { accountId } = res.locals as { accountId: string };
      const settings = await dependencies.retrievalSettingsService.updateForAccount(accountId, req.body);
      res.status(200).json(settings);
    } catch (error) {
      next(error);
    }
  });

  return router;
};
