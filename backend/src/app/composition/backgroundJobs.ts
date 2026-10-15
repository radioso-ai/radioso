import { BackgroundJobRepository } from "../../db/repositories/backgroundJobRepository.js";
import {
  BackgroundJobRuntime,
  DefaultBackgroundJobQueue,
  type BackgroundJobHandlerRegistration,
  type BackgroundJobQueue,
} from "../../shared/background-jobs/index.js";
import { TtlRetentionWorker } from "../../shared/domain/ttlRetentionWorker.js";
import type { ErrorReporter } from "../../shared/errors/errorReporter.js";
import type { Db } from "../../shared/infra/kysely/types.js";
import type { AppLogger } from "../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../shared/observability/metrics/metricsRegistry.js";
import { createDefaultBackgroundJobWake } from "./defaultComposition.js";

/** How long a dead-lettered job stays readable, with its last error, before the sweep removes it. */
const BACKGROUND_JOB_DEAD_LETTER_RETENTION_DAYS = 14;

interface BackgroundJobComposition {
  /** The producer port every module enqueues through. */
  queue: BackgroundJobQueue;
  /** Builds the runtime over every kind's handler; the worker runtimes drain it. */
  createRuntime(handlers: readonly BackgroundJobHandlerRegistration[]): BackgroundJobRuntime;
  /** Removes dead-lettered jobs past the retention window. */
  retentionWorker: TtlRetentionWorker;
}

/**
 * Assembles the generic `background_jobs` store, the wake transport `WORKER_DISPATCH_DRIVER`
 * selects, the producer queue, and the dead-letter retention sweep. The queue exists before the
 * modules that enqueue are built; the runtime is created after them, from the handlers they return.
 */
export const createBackgroundJobComposition = (input: {
  db: Db;
  env: Parameters<typeof createDefaultBackgroundJobWake>[0];
  logger: AppLogger;
  metrics: MetricsRegistry | null;
  errorReporter: ErrorReporter;
  audit: ConstructorParameters<typeof TtlRetentionWorker>[0]["audit"];
}): BackgroundJobComposition => {
  const store = new BackgroundJobRepository(input.db);
  const wake = createDefaultBackgroundJobWake(input.env);
  return {
    queue: new DefaultBackgroundJobQueue({ writer: store, wake, logger: input.logger, metrics: input.metrics }),
    createRuntime: (handlers) =>
      new BackgroundJobRuntime({
        store,
        handlers,
        wake,
        logger: input.logger,
        metrics: input.metrics,
        errorReporter: input.errorReporter,
      }),
    retentionWorker: new TtlRetentionWorker({
      subject: "background_job_dead_letter",
      sweep: store,
      audit: input.audit,
      logger: input.logger,
      retentionDays: BACKGROUND_JOB_DEAD_LETTER_RETENTION_DAYS,
    }),
  };
};
