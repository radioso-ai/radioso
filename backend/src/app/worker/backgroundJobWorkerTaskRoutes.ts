import { Router } from "express";
import { z } from "zod";

import { serviceUnavailable } from "../../shared/domain/errors.js";
import type { AppDependencies } from "../server/types.js";

/**
 * A pushed wake usually stands for one job; the cap keeps one request well inside the Cloud Run
 * request timeout even when each job is a model call. The scheduled sweep asks for more.
 */
const DEFAULT_DRAIN_MAX_JOBS = 5;

const drainSchema = z.object({
  maxJobs: z.number().int().min(1).max(50).default(DEFAULT_DRAIN_MAX_JOBS),
}).default({});

type BackgroundJobWorkerTaskRouteDependencies = Pick<
  AppDependencies,
  "backgroundJobRuntime" | "backgroundJobRetentionWorker"
>;

export const createBackgroundJobWorkerTaskRoutes = (
  dependencies: BackgroundJobWorkerTaskRouteDependencies,
): Router => {
  const router = Router();

  // One route for both triggers: a Cloud Task pushed after a job is written (or scheduled for a
  // retry's due time), and the Cloud Scheduler recovery sweep. A drain claims whatever is due —
  // including jobs whose lease expired — so a duplicate or racing request finds nothing left.
  // A store failure answers 5xx so Cloud Tasks retries the wake; a handler failure is recorded on
  // the job and answers 200.
  router.post("/internal/tasks/background-jobs/drain", async (req, res, next) => {
    const parsed = drainSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_task_payload" });
      return;
    }
    try {
      res.status(200).json(await dependencies.backgroundJobRuntime.drain({ maxJobs: parsed.data.maxJobs }));
    } catch (error) {
      next(error);
    }
  });

  // The task-runtime counterpart of the retention poll loop `startWorkerRuntime` runs.
  router.post("/internal/tasks/background-job-retention/sweep", async (_req, res, next) => {
    try {
      const result = await dependencies.backgroundJobRetentionWorker.sweep();
      if (result.status === "failed") {
        next(serviceUnavailable("Background job retention sweep failed", { reason: result.error }));
        return;
      }
      res.status(200).json({ deleted: result.status === "swept" ? result.deleted : 0, status: result.status });
    } catch (error) {
      next(error);
    }
  });

  return router;
};
