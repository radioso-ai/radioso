import { Router } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import { requireApiToken } from "../middleware/requireApiToken.js";
import { validateBody } from "../middleware/validate.js";

const documentSchema = z.object({
  title: z.string().min(1),
  content: z.string().min(1),
});

export const createDocumentRoutes = (dependencies: AppDependencies): Router => {
  const router = Router();

  router.post("/", requireApiToken(dependencies), validateBody(documentSchema), async (req, res, next) => {
    try {
      const { accountId } = res.locals as { accountId: string };
      const result = await dependencies.documentIngestionService.ingest({
        accountId,
        title: req.body.title,
        content: req.body.content,
      });
      res.status(201).json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
};
