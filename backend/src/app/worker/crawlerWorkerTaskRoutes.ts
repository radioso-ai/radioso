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

export interface CrawlerWorkerTaskRouteOptions {
  now?: () => Date;
  recoveryRequestBudgetMs?: number;
  crawlSliceBudgetMs?: number;
}

const DEFAULT_RECOVERY_REQUEST_BUDGET_MS = 150_000;
const DEFAULT_CRAWL_SLICE_BUDGET_MS = 120_000;

export const createCrawlerWorkerTaskRoutes = (
  dependencies: CrawlerWorkerTaskRouteDependencies,
  options: CrawlerWorkerTaskRouteOptions = {},
): Router => {
  const router = Router();
  const now = options.now ?? (() => new Date());
  const recoveryRequestBudgetMs = options.recoveryRequestBudgetMs ?? DEFAULT_RECOVERY_REQUEST_BUDGET_MS;
  const crawlSliceBudgetMs = options.crawlSliceBudgetMs ?? DEFAULT_CRAWL_SLICE_BUDGET_MS;
  const latestFollowUpStartMs = Math.max(0, recoveryRequestBudgetMs - crawlSliceBudgetMs);

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
      const recoveryStartedAt = now();
      let processedJobCount = 0;
      for (let index = 0; index < parsed.data.maxJobs; index += 1) {
        const iterationStartedAt = now();
        if (
          index > 0
          && iterationStartedAt.getTime() - recoveryStartedAt.getTime() >= latestFollowUpStartMs
        ) {
          break;
        }
        const processed = await dependencies.websiteCrawlWorker.runOnce(iterationStartedAt);
        if (!processed) {
          break;
        }
        processedJobCount += 1;
        if (processed === "yielded") {
          break;
        }
      }

      res.status(200).json({ processedJobCount });
    } catch (error) {
      next(error);
    }
  });

  return router;
};
