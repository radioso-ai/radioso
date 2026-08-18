import { Router, type RequestHandler } from "express";
import { z } from "zod";

import type { AppDependencies } from "../server/types.js";

const documentProcessingTaskSchema = z.object({
  jobId: z.string().uuid(),
  documentId: z.string().uuid().optional(),
  workspaceId: z.string().uuid().optional(),
  revision: z.number().int().positive().optional(),
});

const recoveryTaskSchema = z.object({
  maxJobs: z.number().int().min(1).max(50).default(5),
}).default({});

type DocumentWorkerTaskRouteDependencies = Pick<AppDependencies, "documentProcessingWorker">;

// Compatibility tombstone for Cloud Tasks pushes enqueued before the crawler
// worker split. Mount this ahead of task authentication and JSON parsing so
// headerless legacy tasks receive a permanent 410 instead of retryable 401/400.
export const legacyWebsiteCrawlTaskHandler: RequestHandler = (_req, res) => {
  res.status(410).json({
    error: "moved",
    message: "Website crawl tasks are handled by the dedicated crawler worker. Scheduled recovery will reclaim this job.",
  });
};

export const createDocumentWorkerTaskRoutes = (
  dependencies: DocumentWorkerTaskRouteDependencies,
): Router => {
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

  router.post("/internal/tasks/document-processing/recover", async (req, res, next) => {
    const parsed = recoveryTaskSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_task_payload",
      });
      return;
    }

    try {
      let processedJobCount = 0;
      for (let index = 0; index < parsed.data.maxJobs; index += 1) {
        const processed = await dependencies.documentProcessingWorker.runOnce(new Date());
        if (!processed) {
          break;
        }
        processedJobCount += 1;
      }
      await dependencies.documentProcessingWorker.runPostJobMaintenance(10);

      res.status(200).json({ processedJobCount });
    } catch (error) {
      next(error);
    }
  });

  return router;
};
