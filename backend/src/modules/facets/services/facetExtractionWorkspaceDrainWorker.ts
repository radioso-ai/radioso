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
import { emitFacetExtractionTelemetry } from "./facetExtractionTelemetry.js";

const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_JOB_LEASE_MS = 300_000;

/**
 * Retry budget, mirroring `DocumentProcessingWorker`: three attempts, then terminal.
 * The delay for attempt N is `RETRY_DELAYS_MS[N - 1]`, clamped to the last entry so the
 * schedule keeps growing if the budget is ever raised.
 */
export const FACET_EXTRACTION_MAX_ATTEMPTS = 3;
export const FACET_EXTRACTION_RETRY_DELAYS_MS = [1_000, 5_000, 15_000] as const;

interface FacetExtractionWorkspaceDrainWorkerOptions {
  jobs: FacetExtractionJobStore;
  extraction: FacetExtractionPort;
  logger: Pick<AppLogger, "info" | "warn" | "error" | "debug">;
  batchSize?: number;
  jobLeaseMs?: number;
  telemetryService?: Pick<TelemetryService, "emit">;
}

const retryDelayMs = (attemptCount: number): number =>
  FACET_EXTRACTION_RETRY_DELAYS_MS[
    Math.min(Math.max(attemptCount - 1, 0), FACET_EXTRACTION_RETRY_DELAYS_MS.length - 1)
  ];

/**
 * Drains one workspace's due facet extraction jobs for an operator-requested Audience Pulse
 * refresh, in concurrent lease-fenced batches so the initial historical report is practical to
 * wait for.
 *
 * This is deliberately not the generic per-message path (`facetExtractionBackgroundJobStore.ts`):
 * Audience Pulse needs work scoped to one workspace and one message window, claimed in parallel
 * batches, which the generic port's claim (kind-filtered only, one job at a time) cannot express.
 * The durable `facet_extraction_jobs` table is the shared source of truth either way, so the two
 * paths never claim the same row.
 */
export class FacetExtractionWorkspaceDrainWorker {
  private readonly jobs: FacetExtractionJobStore;
  private readonly extraction: FacetExtractionPort;
  private readonly logger: FacetExtractionWorkspaceDrainWorkerOptions["logger"];
  private readonly batchSize: number;
  private readonly jobLeaseMs: number;
  private readonly telemetryService: FacetExtractionWorkspaceDrainWorkerOptions["telemetryService"];

  constructor(options: FacetExtractionWorkspaceDrainWorkerOptions) {
    this.jobs = options.jobs;
    this.extraction = options.extraction;
    this.logger = options.logger;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.jobLeaseMs = options.jobLeaseMs ?? DEFAULT_JOB_LEASE_MS;
    this.telemetryService = options.telemetryService;
  }

  /**
   * Drains one workspace's due jobs for an operator-requested Audience Pulse refresh.
   * Claims remain scoped and lease-fenced, while concurrent extraction inside each
   * normal-sized batch makes the initial historical report practical to wait for.
   */
  async drainWorkspace(input: {
    workspaceId: string;
    analysisStart: Date;
    analysisEnd: Date;
    maxJobs: number;
    now?: Date;
  }): Promise<number> {
    const now = input.now ?? new Date();
    await this.releaseExpiredClaims(now, input.workspaceId);

    let processed = 0;
    while (processed < input.maxJobs) {
      const limit = Math.min(this.batchSize, input.maxJobs - processed);
      const batch = await this.jobs.claimBatch(limit, now, input.workspaceId, {
        start: input.analysisStart,
        end: input.analysisEnd,
      });
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

  private async releaseExpiredClaims(now: Date, workspaceId: string): Promise<void> {
    const released = await this.jobs.releaseExpiredClaims({
      claimedAtOrBefore: new Date(now.getTime() - this.jobLeaseMs),
      maxAttempts: FACET_EXTRACTION_MAX_ATTEMPTS,
      workspaceId,
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
          await emitFacetExtractionTelemetry(this.telemetryService, "facet.extraction.job_skipped", job, {
            durationMs: Date.now() - startedAt,
            outcome: "skipped",
            reason: outcome.reason,
          });
        }
        return;
      }
      if (await this.jobs.markCompleted(job)) {
        await emitFacetExtractionTelemetry(this.telemetryService, "facet.extraction.job_completed", job, {
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
    await emitFacetExtractionTelemetry(this.telemetryService, "facet.extraction.job_failed", job, {
      durationMs,
      outcome: nextScheduledAt ? "retry_scheduled" : permanent ? "failed_permanent" : "failed",
      reason,
    });
  }
}
