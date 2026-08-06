import { Router } from "express";
import { z } from "zod";

import type { AppDependencies } from "../server/types.js";

const drainRecoverySchema = z.object({
  maxJobs: z.number().int().min(1).max(50).default(5),
}).default({});

type ActionDispatchWorkerTaskRouteDependencies = Pick<AppDependencies, "actionDispatchWorker">;

export const createActionDispatchWorkerTaskRoutes = (
  dependencies: ActionDispatchWorkerTaskRouteDependencies,
): Router => {
  const router = Router();

  // Pushed once per turn that emitted a routine action (contact.send, handoff.notify,
  // approval.request, ...), at emit time. Cloud Tasks delivers at-least-once and a
  // push carries no row-specific payload, so this just triggers one drain batch —
  // draining is idempotent via the outbox's own claim/lease model (FOR UPDATE SKIP
  // LOCKED + attempt-guarded writes), so a duplicate or racing push safely finds
  // nothing left to claim.
  router.post("/internal/tasks/actions/drain", async (_req, res, next) => {
    try {
      await dependencies.actionDispatchWorker.drain();
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  // Scheduled recovery sweep, mirroring /internal/tasks/document-processing/recover:
  // picks up actions whose push was never sent or was lost, and retries whose backoff
  // has elapsed. `maxJobs` here bounds drain *batches* (each up to the worker's
  // configured batchSize rows), not individual rows — a request bounds total work per
  // invocation the same way the document recovery endpoint bounds job count.
  router.post("/internal/tasks/actions/recover", async (req, res, next) => {
    const parsed = drainRecoverySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_task_payload" });
      return;
    }

    try {
      let processedBatchCount = 0;
      for (let index = 0; index < parsed.data.maxJobs; index += 1) {
        const result = await dependencies.actionDispatchWorker.drain();
        if (!result || (result.dispatched === 0 && result.retried === 0 && result.failed === 0)) {
          break;
        }
        processedBatchCount += 1;
      }

      res.status(200).json({ processedBatchCount });
    } catch (error) {
      next(error);
    }
  });

  return router;
};
