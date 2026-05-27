import { Router } from "express";
import { z } from "zod";

import type { AppDependencies } from "../server/types.js";

const websiteCrawlTaskSchema = z.object({
  jobId: z.string().uuid(),
  workspaceId: z.string().uuid().optional(),
});

const recoveryTaskSchema = z.object({
  maxJobs: z.number().int().min(1).max(50).default(5),
}).default({});

type CrawlerWorkerTaskRouteDependencies = Pick<AppDependencies, "websiteCrawlWorker">;

export const createCrawlerWorkerTaskRoutes = (
  dependencies: CrawlerWorkerTaskRouteDependencies,
): Router => {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  router.post("/internal/tasks/website-crawl", async (req, res, next) => {
    const parsed = websiteCrawlTaskSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_task_payload",
      });
      return;
    }

    try {
      const result = await dependencies.websiteCrawlWorker.runJobById(parsed.data.jobId);
      if (result === "busy") {
        res.status(429).json({ status: "busy" });
        return;
      }

      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.post("/internal/tasks/website-crawl/recover", async (req, res, next) => {
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
        const processed = await dependencies.websiteCrawlWorker.runOnce(new Date());
        if (!processed) {
          break;
        }
        processedJobCount += 1;
      }

      res.status(200).json({ processedJobCount });
    } catch (error) {
      next(error);
    }
  });

  return router;
};
