import { Router, type RequestHandler } from "express";
import { z } from "zod";

import { serviceUnavailable } from "../../shared/domain/errors.js";
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

const facetDrainTaskSchema = z.object({
  workspaceId: z.string().uuid(),
  analysisStart: z.coerce.date(),
  analysisEnd: z.coerce.date(),
});

// One recovery request must have a predictable LLM-work budget even when the
// facet worker's normal poll-loop batch size is configured much higher. A
// stricter worker configuration remains authoritative.
const FACET_RECOVERY_MAX_JOBS = 10;
const FACET_TASK_DRAIN_MAX_JOBS = 100;

type DocumentWorkerTaskRouteDependencies = Pick<
  AppDependencies,
  "documentProcessingWorker" | "facetExtractionWorker" | "facetExtractionWorkspaceDrain" | "copilotRetentionWorker"
>;

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

      // Cloud Run serves this worker as a request-driven task server, so the
      // local worker runtime's facet poll loop is not alive in production.
      // The durable facet queue uses the same claim/lease semantics as document
      // recovery; drain one claim of at most this size whenever Scheduler wakes
      // the service. The document-recovery budget must not multiply model-backed
      // facet extraction work.
      const processedFacetJobCount = await dependencies.facetExtractionWorker
        ?.runOnce(new Date(), FACET_RECOVERY_MAX_JOBS) ?? 0;

      res.status(200).json({ processedJobCount, processedFacetJobCount });
    } catch (error) {
      next(error);
    }
  });

  router.post("/internal/tasks/facet-extraction/drain", async (req, res, next) => {
    const parsed = facetDrainTaskSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_task_payload" });
      return;
    }
    if (!dependencies.facetExtractionWorker) {
      res.status(503).json({ error: "facet_extraction_unavailable" });
      return;
    }
    try {
      const processedJobCount = await dependencies.facetExtractionWorker.drainWorkspace({
        workspaceId: parsed.data.workspaceId,
        analysisStart: parsed.data.analysisStart,
        analysisEnd: parsed.data.analysisEnd,
        maxJobs: FACET_TASK_DRAIN_MAX_JOBS,
      });
      // Chain only after this slice completes. The queue is durable and claims are
      // fenced, so duplicate tasks simply find no jobs and do no provider work.
      await dependencies.facetExtractionWorkspaceDrain?.requestWorkspaceDrain(parsed.data);
      res.status(200).json({ processedJobCount });
    } catch (error) {
      next(error);
    }
  });

  // The task-runtime counterpart to the poll loop `startWorkerRuntime` runs. Retention has no
  // per-item queue to push against, so a scheduled sweep is the whole trigger — and without this
  // route the window would be enforced in docker-compose and nowhere else.
  router.post("/internal/tasks/copilot-retention/sweep", async (_req, res, next) => {
    try {
      const result = await dependencies.copilotRetentionWorker.sweep();
      if (result.status === "failed") {
        // Retryable on purpose. Retention has no queue behind it, so a scheduled push reported as
        // success is the whole enforcement for that interval quietly not happening.
        next(serviceUnavailable("Copilot retention sweep failed", { reason: result.error }));
        return;
      }
      // Switched off or already in flight are both ordinary, and neither is worth a retry.
      res.status(200).json({ deleted: result.status === "swept" ? result.deleted : 0, status: result.status });
    } catch (error) {
      next(error);
    }
  });

  return router;
};
