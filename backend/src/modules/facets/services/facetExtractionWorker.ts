import type { ErrorReporter } from "../../../shared/errors/errorReporter.js";
import {
  getProviderFailureReason,
  isPermanentProviderFailure,
} from "../../../shared/infra/llm/providerErrors.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import type { TelemetryService } from "../../../shared/observability/telemetry/telemetryService.js";
import type {
  FacetExtractionJob,
  FacetExtractionJobStore,
  FacetExtractionPort,
} from "../contracts.js";

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_JOB_LEASE_MS = 300_000;

/**
 * Retry budget, mirroring `DocumentProcessingWorker`: three attempts, then terminal.
 * The delay for attempt N is `RETRY_DELAYS_MS[N - 1]`, clamped to the last entry so the
 * schedule keeps growing if the budget is ever raised.
 */
export const FACET_EXTRACTION_MAX_ATTEMPTS = 3;
export const FACET_EXTRACTION_RETRY_DELAYS_MS = [1_000, 5_000, 15_000] as const;

export interface FacetExtractionWorkerOptions {
  jobs: FacetExtractionJobStore;
  extraction: FacetExtractionPort;
  logger: Pick<AppLogger, "info" | "warn" | "error" | "debug">;
  pollIntervalMs?: number;
  batchSize?: number;
  jobLeaseMs?: number;
  telemetryService?: Pick<TelemetryService, "emit">;
  errorReporter?: Pick<ErrorReporter, "report">;
}

const retryDelayMs = (attemptCount: number): number =>
  FACET_EXTRACTION_RETRY_DELAYS_MS[
    Math.min(Math.max(attemptCount - 1, 0), FACET_EXTRACTION_RETRY_DELAYS_MS.length - 1)
  ]!;

/**
 * Drains the facet extraction queue on a poll loop in the worker process.
 *
 * Facet extraction is batch analytics — no turn or request waits on it — so a polling
 * claim loop is the whole transport. Claiming is atomic and lease-guarded, which is what
 * makes it safe to run more than one worker process against the same queue.
 *
 * The worker owns the retry policy and the job lifecycle; the extraction itself is an
 * injected port, so this class never learns what a facet is or which model produces it.
 */
export class FacetExtractionWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopRequested = false;
  private inFlightTick: Promise<unknown> | null = null;

  private readonly jobs: FacetExtractionJobStore;
  private readonly extraction: FacetExtractionPort;
  private readonly logger: FacetExtractionWorkerOptions["logger"];
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly jobLeaseMs: number;
  private readonly telemetryService: FacetExtractionWorkerOptions["telemetryService"];
  private readonly errorReporter: FacetExtractionWorkerOptions["errorReporter"];

  constructor(options: FacetExtractionWorkerOptions) {
    this.jobs = options.jobs;
    this.extraction = options.extraction;
    this.logger = options.logger;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.jobLeaseMs = options.jobLeaseMs ?? DEFAULT_JOB_LEASE_MS;
    this.telemetryService = options.telemetryService;
    this.errorReporter = options.errorReporter;
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.stopRequested = false;
    this.logger.info(
      { role: "worker", batchSize: this.batchSize, pollIntervalMs: this.pollIntervalMs },
      "Facet extraction worker started",
    );
    this.scheduleNextTick(0);
  }

  /** Stops scheduling and waits for the in-flight tick so shutdown never races a claim. */
  async stop(): Promise<void> {
    this.stopRequested = true;
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.inFlightTick?.catch(() => undefined);
    this.inFlightTick = null;
  }

  /**
   * Claim and process one batch. Returns the number of jobs processed so the poll loop
   * can keep draining without waiting a full interval while the queue has work.
   */
  async runOnce(now: Date = new Date(), maxJobs: number = this.batchSize): Promise<number> {
    await this.releaseExpiredClaims(now);

    const batch = await this.jobs.claimBatch(Math.min(maxJobs, this.batchSize), now);
    let processed = 0;
    for (const job of batch) {
      // A stop mid-batch leaves the remaining claimed rows for the lease reclaim rather
      // than holding shutdown open for the rest of the batch. Only an explicit `stop()`
      // sets this, so a direct `runOnce` call always drains the batch it claimed.
      if (this.stopRequested) {
        break;
      }
      await this.processJob(job, now);
      processed += 1;
    }
    return processed;
  }

  /**
   * Drains one workspace's due jobs for an operator-requested Audience Pulse refresh.
   * Claims remain scoped and lease-fenced, while concurrent extraction inside each
   * normal-sized batch makes the initial historical report practical to wait for.
   */
  async drainWorkspace(input: { workspaceId: string; maxJobs: number; now?: Date }): Promise<number> {
    const now = input.now ?? new Date();
    await this.releaseExpiredClaims(now, input.workspaceId);

    let processed = 0;
    while (!this.stopRequested && processed < input.maxJobs) {
      const limit = Math.min(this.batchSize, input.maxJobs - processed);
      const batch = await this.jobs.claimBatch(limit, now, input.workspaceId);
      if (batch.length === 0) {
        break;
      }
      await Promise.all(batch.map((job) => this.processJob(job, now)));
      processed += batch.length;
      if (batch.length < limit) {
        break;
      }
    }
    return processed;
  }

  private async releaseExpiredClaims(now: Date, workspaceId?: string): Promise<void> {
    const released = await this.jobs.releaseExpiredClaims({
      claimedAtOrBefore: new Date(now.getTime() - this.jobLeaseMs),
      maxAttempts: FACET_EXTRACTION_MAX_ATTEMPTS,
      ...(workspaceId === undefined ? {} : { workspaceId }),
    });
    if (released > 0) {
      this.logger.warn(
        { role: "worker", staleClaimCount: released },
        "Resolved stale facet extraction claims",
      );
    }
  }

  private async processJob(job: FacetExtractionJob, now: Date): Promise<void> {
    const startedAt = Date.now();
    try {
      const outcome = await this.extraction.extract(job);
      if (outcome.status === "skipped") {
        if (await this.jobs.markSkipped(job, outcome.reason)) {
          await this.emit("facet.extraction.job_skipped", job, {
            durationMs: Date.now() - startedAt,
            outcome: "skipped",
            reason: outcome.reason,
          });
        }
        return;
      }
      if (await this.jobs.markCompleted(job)) {
        await this.emit("facet.extraction.job_completed", job, {
          durationMs: Date.now() - startedAt,
          outcome: "completed",
        });
      }
    } catch (error) {
      await this.handleFailure(job, error, now, Date.now() - startedAt);
    }
  }

  private async handleFailure(
    job: FacetExtractionJob,
    error: unknown,
    now: Date,
    durationMs: number,
  ): Promise<void> {
    const reason = getProviderFailureReason(error);
    const permanent = isPermanentProviderFailure(error);
    const hasRetriesRemaining = !permanent && job.attemptCount < FACET_EXTRACTION_MAX_ATTEMPTS;
    const nextScheduledAt = hasRetriesRemaining
      ? new Date(now.getTime() + retryDelayMs(job.attemptCount))
      : null;

    const marked = await this.jobs.markFailed(job, reason, nextScheduledAt);
    if (!marked) {
      return;
    }
    this.logger.warn(
      {
        role: "worker",
        jobId: job.id,
        workspaceId: job.workspaceId,
        attemptCount: job.attemptCount,
        retryScheduled: nextScheduledAt !== null,
        permanent,
      },
      "Facet extraction attempt failed",
    );
    await this.emit("facet.extraction.job_failed", job, {
      durationMs,
      outcome: nextScheduledAt ? "retry_scheduled" : permanent ? "failed_permanent" : "failed",
      reason,
    });
  }

  private scheduleNextTick(delayMs = this.pollIntervalMs): void {
    if (!this.running) {
      return;
    }
    this.timer = setTimeout(() => {
      const tick = this.runOnce()
        .then((processed) => {
          this.scheduleNextTick(processed > 0 ? 0 : this.pollIntervalMs);
        })
        .catch((error: unknown) => {
          this.logger.error(
            { err: error instanceof Error ? error.message : String(error), role: "worker" },
            "Facet extraction worker tick failed",
          );
          // Fire-and-forget so the poll loop is never blocked by reporting, but the
          // rejection must be caught — an unhandled rejection would be process-fatal.
          void this.errorReporter
            ?.report({ errorType: "facet.extraction.tick_failed", error, severity: "error" })
            .catch((reportError: unknown) => {
              this.logger.error(
                {
                  err: reportError instanceof Error ? reportError.message : String(reportError),
                },
                "Facet extraction error report failed",
              );
            });
          this.scheduleNextTick(this.pollIntervalMs);
        });
      this.inFlightTick = tick;
    }, delayMs);
  }

  private async emit(
    eventType:
      | "facet.extraction.job_completed"
      | "facet.extraction.job_failed"
      | "facet.extraction.job_skipped",
    job: FacetExtractionJob,
    input: {
      durationMs: number;
      outcome: "completed" | "skipped" | "retry_scheduled" | "failed" | "failed_permanent";
      reason?: string;
    },
  ): Promise<void> {
    await this.telemetryService?.emit({
      eventType,
      severity: eventType === "facet.extraction.job_failed" ? "error" : "info",
      correlation: { workspaceId: job.workspaceId, jobId: job.id },
      metrics: { durationMs: input.durationMs, attemptCount: job.attemptCount },
      metadata: input.reason ? { reason: input.reason } : undefined,
      tags: { outcome: input.outcome },
    });
  }
}
