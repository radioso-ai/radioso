import { Router } from "express";
import { z } from "zod";

import type { EmailChannelWorker } from "../../modules/connectors/plugins/index.js";

const DEFAULT_MAX_JOBS = 10;

const drainSchema = z.object({
  maxJobs: z.number().int().min(1).max(50).default(DEFAULT_MAX_JOBS),
  stage: z.enum(["inbound", "review", "reconcile", "all"]).default("all"),
}).default({});

const sweepSchema = z.object({
  maxJobs: z.number().int().min(1).max(200).default(50),
}).default({});

/**
 * The email channel's push and schedule triggers (contracts/openapi-additions §5), mounted behind
 * the worker-token middleware. A drain is only a hint: the claim model makes a duplicate or
 * racing push find nothing left, so both routes are safe to repeat.
 */
export const createEmailChannelWorkerTaskRoutes = (dependencies: {
  emailChannelWorker: Pick<EmailChannelWorker, "drain" | "sweep">;
}): Router => {
  const router = Router();

  // Pushed by Cloud Tasks after a webhook commits, and scheduled at a retry's due time.
  router.post("/internal/tasks/email-channel/drain", async (req, res, next) => {
    const parsed = drainSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_task_payload" });
      return;
    }
    try {
      await dependencies.emailChannelWorker.drain(parsed.data);
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  // Cloud Scheduler, every five minutes: lease recovery, domain refresh, retention, then a drain.
  router.post("/internal/tasks/email-channel/sweep", async (req, res, next) => {
    const parsed = sweepSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_task_payload" });
      return;
    }
    try {
      const result = await dependencies.emailChannelWorker.sweep(parsed.data);
      res.status(200).json(result ?? { skipped: "disabled" });
    } catch (error) {
      next(error);
    }
  });

  return router;
};
