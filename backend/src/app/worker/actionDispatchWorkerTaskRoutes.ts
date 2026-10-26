import { Router } from "express";
import { z } from "zod";

import { BACKGROUND_JOB_DRAIN_BUDGET_SECONDS } from "../../shared/background-jobs/index.js";
import type { AppDependencies } from "../server/types.js";

/**
 * One pushed wake drains a full batch, not a single row: a turn that enqueues several actions
 * (for example two routine steps that each dispatch) still sends only one push, so a push that
 * stopped at one job left every action after the first waiting for the next push or the recovery
 * sweep. Matches `ActionDispatchWorker`'s old per-drain batch size.
 */
const DEFAULT_DRAIN_MAX_JOBS = 20;

/** Mirrors `backgroundJobWorkerTaskRoutes.ts`'s drain budget: long enough for one drain request,
 *  short enough that Cloud Tasks and Cloud Scheduler never retry a drain still in flight. */
const DRAIN_BUDGET_MS = BACKGROUND_JOB_DRAIN_BUDGET_SECONDS * 1_000;

const drainSchema = z.object({
  maxJobs: z.number().int().min(1).max(50).default(DEFAULT_DRAIN_MAX_JOBS),
}).prefault({});

/**
 * The recovery sweep's own default: well above one push's batch, since this route exists to
 * clear a backlog a push never reached (lost pushes, a worker outage). `ActionDispatchWorker`'s
 * old recovery route achieved an equivalent ceiling by looping up to 10 batches of 20 rows; this
 * route's `maxJobs` already bounds individual rows directly, so the same ceiling is one number.
 */
const drainRecoverySchema = z.object({
  maxJobs: z.number().int().min(1).max(500).default(200),
}).prefault({});

type ActionDispatchWorkerTaskRouteDependencies = Pick<
  AppDependencies,
  "actionDispatchJobRuntime" | "reportActionOutboxQueueState"
>;

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
      const result = await dependencies.actionDispatchJobRuntime.drain({
        maxJobs: parsed.data.maxJobs,
        budgetMs: DRAIN_BUDGET_MS,
        startedAt,
      });
      // The push worker runs no interval of its own (Cloud Run only runs this process while a
      // request is in flight), so this is the only place production emits the outbox's
      // depth/oldest-pending-age signal. Best-effort: never throws, never delays the response on
      // a reporting failure.
      await dependencies.reportActionOutboxQueueState();
      res.status(200).json(result);
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
      const result = await dependencies.actionDispatchJobRuntime.drain({
        maxJobs: parsed.data.maxJobs,
        budgetMs: DRAIN_BUDGET_MS,
        startedAt,
      });
      await dependencies.reportActionOutboxQueueState();
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
};
