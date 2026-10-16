import {
  backgroundJobHandler,
  BackgroundJobRuntime,
  NonRetryableBackgroundJobError,
} from "../../shared/background-jobs/index.js";
import type { ErrorReporter } from "../../shared/errors/errorReporter.js";
import { isPermanentProviderFailure } from "../../shared/infra/llm/providerErrors.js";
import type { AppLogger } from "../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../shared/observability/metrics/metricsRegistry.js";
import type { TelemetryService } from "../../shared/observability/telemetry/telemetryService.js";
import type { FacetExtractionJob, FacetExtractionJobStore, FacetExtractionPort } from "./contracts.js";
import {
  FACET_EXTRACTION_JOB,
  FacetExtractionBackgroundJobStore,
} from "./infra/facetExtractionBackgroundJobStore.js";
import { emitFacetExtractionTelemetry } from "./services/facetExtractionTelemetry.js";
import { FacetExtractionWorkspaceDrainWorker } from "./services/facetExtractionWorkspaceDrainWorker.js";

export { FacetExtractionWorkspaceDrainWorker } from "./services/facetExtractionWorkspaceDrainWorker.js";
export { FacetExtractionWorkspaceDrainService } from "./services/facetExtractionWorkspaceDrainService.js";
export {
  NoopFacetExtractionDrainDispatcher,
  type FacetExtractionDrainDispatcher,
} from "./contracts.js";
export { CloudTasksFacetExtractionDrainDispatcher } from "./infra/cloudTasksFacetExtractionDrainDispatcher.js";
export {
  FacetExtractionService,
} from "./services/facetExtractionService.js";
export {
  FACET_EXTRACTION_PROMPT_VERSION,
} from "./services/prompt.js";

/**
 * Builds the worker behind Audience Pulse's workspace-scoped, operator-requested drain, or
 * `undefined` when no extraction implementation is registered.
 *
 * Returning `undefined` is the deliberate default: with no extractor, draining the queue
 * could only discard work. Leaving jobs queued keeps them durable until an extractor is
 * registered, at which point the backlog is processed.
 */
export const createFacetExtractionWorkspaceDrainWorker = (input: {
  jobs: FacetExtractionJobStore;
  extraction?: FacetExtractionPort;
  logger: AppLogger;
  batchSize: number;
  jobLeaseMs: number;
  telemetryService?: TelemetryService;
}): FacetExtractionWorkspaceDrainWorker | undefined => {
  if (!input.extraction) {
    return undefined;
  }
  return new FacetExtractionWorkspaceDrainWorker({
    jobs: input.jobs,
    extraction: input.extraction,
    logger: input.logger,
    batchSize: input.batchSize,
    jobLeaseMs: input.jobLeaseMs,
    telemetryService: input.telemetryService,
  });
};

/**
 * Builds the generic-job-port runtime for the per-message path, or `undefined` when no
 * extraction implementation is registered (same reasoning as the workspace drain worker above).
 *
 * The handler reuses `extraction.extract` and the same telemetry shape as the workspace drain
 * worker; only the completion/retry/dead-letter bookkeeping differs, because this path runs
 * through `FacetExtractionBackgroundJobStore` instead of calling `markCompleted` / `markFailed`
 * directly.
 */
export const createFacetExtractionBackgroundJobRuntime = (input: {
  jobs: FacetExtractionJobStore;
  extraction?: FacetExtractionPort;
  logger: AppLogger;
  metrics?: MetricsRegistry | null;
  errorReporter?: ErrorReporter;
  telemetryService?: TelemetryService;
  pollIntervalMs?: number;
  pollBatchSize?: number;
}): BackgroundJobRuntime | undefined => {
  if (!input.extraction) {
    return undefined;
  }
  const extraction = input.extraction;
  const store = new FacetExtractionBackgroundJobStore(
    input.jobs,
    FACET_EXTRACTION_JOB.policy.maxAttempts,
    input.telemetryService,
  );
  const handler = backgroundJobHandler(FACET_EXTRACTION_JOB, async (payload, context) => {
    const startedAt = Date.now();
    // The extractor only reads `id`, `messageId`, `workspaceId`, and `attemptCount` (see
    // `FacetExtractionService.extract`); the remaining `FacetExtractionJob` fields are claim and
    // status bookkeeping this adapter keeps to itself (see `claimNext`'s `token`), so they are
    // placeholders here, never read.
    const job: FacetExtractionJob = {
      id: context.jobId,
      messageId: payload.messageId,
      workspaceId: payload.workspaceId,
      status: "processing",
      attemptCount: context.attempt,
      claimedAt: null,
      scheduledAt: new Date(startedAt),
      lastError: null,
      createdAt: new Date(startedAt),
      updatedAt: new Date(startedAt),
    };
    try {
      const outcome = await extraction.extract(job);
      if (outcome.status === "skipped") {
        store.recordOutcome(context.jobId, { status: "skipped", reason: outcome.reason });
        await emitFacetExtractionTelemetry(input.telemetryService, "facet.extraction.job_skipped", job, {
          durationMs: Date.now() - startedAt,
          outcome: "skipped",
          reason: outcome.reason,
        });
        return;
      }
      store.recordOutcome(context.jobId, { status: "extracted" });
      await emitFacetExtractionTelemetry(input.telemetryService, "facet.extraction.job_completed", job, {
        durationMs: Date.now() - startedAt,
        outcome: "completed",
      });
    } catch (error) {
      // Retry scheduling, the terminal dead-letter, and their telemetry are the store adapter's
      // job (`retry` / `deadLetter`): only it knows which one the generic runtime chose.
      if (isPermanentProviderFailure(error)) {
        throw new NonRetryableBackgroundJobError("Permanent facet extraction provider failure");
      }
      throw error;
    }
  });
  return new BackgroundJobRuntime({
    store,
    handlers: [handler],
    logger: input.logger,
    metrics: input.metrics,
    errorReporter: input.errorReporter,
    pollIntervalMs: input.pollIntervalMs,
    pollBatchSize: input.pollBatchSize,
  });
};
