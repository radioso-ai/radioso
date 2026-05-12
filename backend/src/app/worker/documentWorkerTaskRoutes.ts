import { Router } from "express";
import { z } from "zod";

import type { AppDependencies } from "../server/types.js";

const documentProcessingTaskSchema = z.object({
  jobId: z.string().uuid(),
  documentId: z.string().uuid().optional(),
  workspaceId: z.string().uuid().optional(),
  revision: z.number().int().positive().optional(),
});

type DocumentWorkerTaskRouteDependencies = Pick<AppDependencies, "documentProcessingWorker">;

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

  // Compatibility stub for in-flight Cloud Tasks pushes that were enqueued
  // before the website-crawl Cloud Run service was split out. We respond 410
  // (Gone) so Cloud Tasks treats it as a permanent failure and stops retrying;
  // the polling fallback in the new crawler worker will pick the job up on its
  // next tick. Safe to remove one full release after the split has shipped.
  router.post("/internal/tasks/website-crawl", (_req, res) => {
    res.status(410).json({
      error: "moved",
      message: "Website crawl tasks are handled by the dedicated crawler worker. The polling fallback will reclaim this job.",
    });
  });

  return router;
};
