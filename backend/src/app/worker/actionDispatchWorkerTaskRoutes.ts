import { Router } from "express";
import { z } from "zod";

import { BACKGROUND_JOB_DRAIN_BUDGET_SECONDS } from "../../shared/background-jobs/index.js";
import type { AppDependencies } from "../server/types.js";

/** A pushed wake stands for one job: one dispatch per push, mirroring the shared background-job drain route. */
const DEFAULT_DRAIN_MAX_JOBS = 1;

/** Mirrors `backgroundJobWorkerTaskRoutes.ts`'s drain budget: long enough for one drain request,
 *  short enough that Cloud Tasks and Cloud Scheduler never retry a drain still in flight. */
const DRAIN_BUDGET_MS = BACKGROUND_JOB_DRAIN_BUDGET_SECONDS * 1_000;

const drainSchema = z.object({
  maxJobs: z.number().int().min(1).max(50).default(DEFAULT_DRAIN_MAX_JOBS),
}).default({});

/** The recovery sweep's own default, carried over from `ActionDispatchWorker`'s batch size. */
const drainRecoverySchema = z.object({
  maxJobs: z.number().int().min(1).max(50).default(5),
}).default({});

type ActionDispatchWorkerTaskRouteDependencies = Pick<AppDependencies, "actionDispatchJobRuntime">;

export const createActionDispatchWorkerTaskRoutes = (
  dependencies: ActionDispatchWorkerTaskRouteDependencies,
): Router => {
  const router = Router();

  // Pushed once per turn that emitted a routine action (contact.send, handoff.notify,
  // approval.request, ...), at emit time. Cloud Tasks delivers at-least-once and a push carries
  // no row-specific payload, so this just asks for one drain — claiming is idempotent via the
  // outbox's own claim/lease model (FOR UPDATE SKIP LOCKED + attempt-guarded writes), so a
  // duplicate or racing push safely finds nothing left to claim.
  router.post("/internal/tasks/actions/drain", async (req, res, next) => {
    const startedAt = Date.now();
    const parsed = drainSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_task_payload" });
      return;
    }
    try {
      res.status(200).json(await dependencies.actionDispatchJobRuntime.drain({
        maxJobs: parsed.data.maxJobs,
        budgetMs: DRAIN_BUDGET_MS,
        startedAt,
      }));
    } catch (error) {
      next(error);
    }
  });

  // Scheduled recovery sweep, mirroring /internal/tasks/document-processing/recover and the
  // shared background-job drain route: picks up actions whose push was never sent or was lost,
  // and retries whose backoff has elapsed. `maxJobs` bounds individual claimed rows per
  // invocation (the generic runtime's own `drain` semantics), not request batches.
  router.post("/internal/tasks/actions/recover", async (req, res, next) => {
    const startedAt = Date.now();
    const parsed = drainRecoverySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_task_payload" });
      return;
    }
    try {
      res.status(200).json(await dependencies.actionDispatchJobRuntime.drain({
        maxJobs: parsed.data.maxJobs,
        budgetMs: DRAIN_BUDGET_MS,
        startedAt,
      }));
    } catch (error) {
      next(error);
    }
  });

  return router;
};
