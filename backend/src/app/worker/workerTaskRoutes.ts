import { Router } from "express";
import { z } from "zod";

import type { AppDependencies } from "../server/types.js";

const documentProcessingTaskSchema = z.object({
  jobId: z.string().uuid(),
  documentId: z.string().uuid().optional(),
  workspaceId: z.string().uuid().optional(),
  revision: z.number().int().positive().optional(),
});

export const createWorkerTaskRoutes = (dependencies: AppDependencies): Router => {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  router.post("/internal/tasks/document-processing", async (req, res, next) => {
    const parsed = documentProcessingTaskSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_task_payload",
      });
      return;
    }

    try {
      const result = await dependencies.documentProcessingWorker.runJobById(parsed.data.jobId);
      if (result === "busy") {
        res.status(429).json({ status: "busy" });
        return;
      }

      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  return router;
};
