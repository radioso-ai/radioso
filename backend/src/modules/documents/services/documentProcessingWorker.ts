import type { ErrorReporter } from "../../../shared/errors/errorReporter.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import type { TelemetryService } from "../../../shared/observability/telemetry/telemetryService.js";
import { traceOperation } from "../../../shared/observability/tracing/operations.js";
import type { AuditService } from "../../audit/contracts/index.js";
import type { DocumentRepositoryPort } from "./documentIngestionService.js";
import type {
  DocumentProcessingJobRecord,
  DocumentProcessingQueueSnapshot,
  DocumentProcessingJobRepositoryPort,
} from "../../../db/repositories/documentProcessingJobRepository.js";
import { DocumentProcessingService } from "./documentProcessingService.js";
import { getProviderFailureReason, isPermanentProviderFailure } from "../../../shared/infra/llm/providerErrors.js";
import { NoopDocumentJobDispatcher, type DocumentJobDispatcherPort } from "./documentJobDispatcher.js";

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_JOB_LEASE_MS = 300_000;
const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [1_000, 5_000, 15_000] as const;

type TraceAttributes = Record<string, unknown>;

const traceActiveSpan = <T>(
  name: string,
  attributes: TraceAttributes,
  run: () => Promise<T> | T,
  resultAttributes?: (result: T) => TraceAttributes,
): Promise<T> => traceOperation({ name, attributes, run, resultAttributes });

const compactTraceAttributes = (attributes: TraceAttributes): TraceAttributes =>
  Object.fromEntries(
    Object.entries(attributes).filter(([, value]) => value !== undefined && value !== null),
  ) as TraceAttributes;

export const buildDocumentWorkerJobTraceAttributes = (
  job: Pick<DocumentProcessingJobRecord, "id" | "workspaceId" | "documentId" | "documentRevision" | "attemptCount" | "status" | "kind">,
  input: { outcome?: "completed" | "stale" | "deleted" | "retry_scheduled" | "failed" | "failed_permanent" | "processed" | "noop" | "busy" } = {},
): TraceAttributes => compactTraceAttributes({
  "radioso.workspace_id": job.workspaceId,
  "radioso.document_id": job.documentId,
  "radioso.job_id": job.id,
  "document.revision": job.documentRevision,
  "document.job.id": job.id,
  "document.job.kind": job.kind,
  "document.job.attempt_count": job.attemptCount,
  "document.job.status": job.status,
  "document.worker.outcome": input.outcome,
});

export class DocumentProcessingWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastActivityState: "idle" | "processing" | null = null;

  constructor(
    private readonly documentRepository: DocumentRepositoryPort,
    private readonly jobRepository: DocumentProcessingJobRepositoryPort,
    private readonly processingService: DocumentProcessingService,
    private readonly auditService: AuditService,
    private readonly logger: AppLogger,
    private readonly pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    private readonly jobDispatcher: DocumentJobDispatcherPort = new NoopDocumentJobDispatcher(),
    private readonly jobLeaseMs = DEFAULT_JOB_LEASE_MS,
    private readonly telemetryService?: TelemetryService,
    private readonly errorReporter?: ErrorReporter,
  ) {}

  async start(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    const inFlightJobs = await this.jobRepository.listProcessingJobs();
    await Promise.all(inFlightJobs.map(async (job) => {
      const document = await this.documentRepository.findByIdAndWorkspaceId(job.documentId, job.workspaceId);
      if (!document) {
        await this.jobRepository.markSkipped(job.id, "document_deleted");
        return;
      }

      if (document.revision !== job.documentRevision) {
        await this.jobRepository.markSkipped(job.id, "stale_revision");
        return;
      }

      // Enrich jobs run against an already-ready document, so readiness is not
      // proof the enrichment ran. Release the job to run again on restart, and
      // never touch the document status — the vectorize path owns readiness.
      if (job.kind === "enrich") {
        await this.jobRepository.reschedule(job.id, new Date(), "worker_restarted");
        return;
      }

      if (document.status === "ready") {
        await this.jobRepository.markCompleted(job.id);
        return;
      }

      await this.jobRepository.reschedule(job.id, new Date(), "worker_restarted");
      await this.documentRepository.setStatusIfRevisionMatches({
        documentId: job.documentId,
        workspaceId: job.workspaceId,
        revision: job.documentRevision,
        status: "queued",
        failureReason: null,
      });
    }));
    await this.repairQueueGaps();
    await this.logQueueState("Document processing worker started", "document.worker.started", "started");
    this.scheduleNextTick(0);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  async runOnce(now: Date = new Date()): Promise<boolean> {
    await this.releaseStaleClaims(now);
    const job = await this.claimNextAvailableJob(now);
    if (!job) {
      if (this.lastActivityState !== "idle") {
        await this.logQueueState("Document processing worker idle", "document.worker.idle", "idle");
        this.lastActivityState = "idle";
      }
      return false;
    }

    this.lastActivityState = "processing";
    await this.logQueueState("Document processing worker processing", "document.worker.processing", "processing");
    await this.processClaimedJob(job);

    return true;
  }

  async runJobById(jobId: string, now: Date = new Date()): Promise<"processed" | "noop" | "busy"> {
    return traceActiveSpan("document.worker.run_job_by_id", { "document.job.id": jobId }, async () => {
      const existing = await this.jobRepository.findById(jobId);
      if (!existing) {
        return "noop";
      }

      if (existing.status === "completed" || existing.status === "failed" || existing.status === "skipped") {
        return "noop";
      }

      if (existing.status === "processing") {
        const claimedBefore = new Date(now.getTime() - this.jobLeaseMs);
        const released = await this.jobRepository.releaseTimedOutClaim(jobId, claimedBefore, "claim_expired");
        if (!released) {
          return "busy";
        }
      }

      const claimed = await this.jobRepository.claimById(jobId, now);
      if (!claimed) {
        const current = await this.jobRepository.findById(jobId);
        if (
          current?.status === "processing"
          && current.claimedAt
          && current.claimedAt.getTime() > now.getTime() - this.jobLeaseMs
        ) {
          return "busy";
        }
        return "noop";
      }

      await this.processClaimedJob(claimed);
      return "processed";
    }, (outcome) => ({ "document.worker.outcome": outcome }));
  }

  private async claimNextAvailableJob(now: Date): Promise<DocumentProcessingJobRecord | null> {
    const nextJob = await this.jobRepository.claimNext(now);
    if (nextJob) {
      return nextJob;
    }

    const repairedJobCount = await this.repairQueueGaps();
    if (repairedJobCount === 0) {
      return null;
    }

    return this.jobRepository.claimNext();
  }

  private async releaseStaleClaims(now: Date): Promise<void> {
    const claimedAtOrBefore = new Date(now.getTime() - this.jobLeaseMs);
    const processingJobs = await this.jobRepository.listProcessingJobs();
    const staleJobs = processingJobs.filter((job) =>
      job.claimedAt !== null && job.claimedAt.getTime() <= claimedAtOrBefore.getTime()
    );

    if (staleJobs.length === 0) {
      return;
    }

    const releaseResults = await Promise.all(
      staleJobs.map((job) => this.jobRepository.releaseTimedOutClaim(job.id, claimedAtOrBefore, "claim_expired")),
    );
    const releasedCount = releaseResults.filter(Boolean).length;
    if (releasedCount === 0) {
      return;
    }

    this.logger.warn(
      {
        role: "worker",
        releasedCount,
      },
      "Released stale processing document jobs back to queue",
    );
  }

  private scheduleNextTick(delayMs = this.pollIntervalMs): void {
    if (!this.running) {
      return;
    }

    this.timer = setTimeout(async () => {
      try {
        const processed = await this.runOnce();
        this.scheduleNextTick(processed ? 0 : this.pollIntervalMs);
      } catch (error) {
        this.logger.error({ error }, "Document processing worker tick failed");
        // Fire-and-forget so the poll loop is never blocked by reporting, but the
        // rejection must be caught — an unhandled rejection would now be process-fatal.
        void this.errorReporter
          ?.report({ errorType: "document.worker.tick_failed", error, severity: "error" })
          .catch((reportError) => {
            this.logger.error(
              { err: reportError instanceof Error ? reportError.message : String(reportError) },
              "Document processing worker error report failed",
            );
          });
        this.scheduleNextTick(this.pollIntervalMs);
      }
    }, delayMs);
  }

  private async processClaimedJob(job: DocumentProcessingJobRecord): Promise<void> {
    return traceActiveSpan("document.worker.job", buildDocumentWorkerJobTraceAttributes(job), async () => {
      const startedAt = Date.now();

      try {
        const outcome = job.kind === "enrich"
          ? await this.processingService.processEnrichment(job)
          : await this.processingService.process(job);
        if (outcome === "completed") {
          await this.jobRepository.markCompleted(job.id);
          await this.emitJobTelemetry("document.worker.job_completed", job, {
            durationMs: Date.now() - startedAt,
            outcome: "completed",
          });
        } else {
          await this.jobRepository.markSkipped(job.id, outcome === "stale" ? "stale_revision" : "document_deleted");
          await this.emitJobTelemetry("document.worker.job_skipped", job, {
            durationMs: Date.now() - startedAt,
            outcome,
          });
        }
      } catch (error) {
        await this.handleFailure(job, error, Date.now() - startedAt);
      }
    });
  }

  private async handleFailure(job: DocumentProcessingJobRecord, error: unknown, durationMs: number): Promise<void> {
    return traceActiveSpan("document.worker.job_failure", buildDocumentWorkerJobTraceAttributes(job), async () => {
      const message = getProviderFailureReason(error);
      const isPermanent = isPermanentProviderFailure(error);
      const hasRetriesRemaining = !isPermanent && job.attemptCount < MAX_ATTEMPTS;

      if (hasRetriesRemaining) {
        const delayMs =
          RETRY_DELAYS_MS[Math.min(job.attemptCount - 1, RETRY_DELAYS_MS.length - 1)] ?? this.pollIntervalMs;
        const nextAttemptAt = new Date(Date.now() + delayMs);
        await this.jobRepository.reschedule(job.id, nextAttemptAt, message);
        // Enrich jobs run against an already-ready document; a retry must never
        // knock it back to "queued" — only the vectorize path owns document status.
        if (job.kind !== "enrich") {
          await this.documentRepository.setStatusIfRevisionMatches({
            documentId: job.documentId,
            workspaceId: job.workspaceId,
            revision: job.documentRevision,
            status: "queued",
            failureReason: null,
          });
        }
        await this.jobDispatcher.dispatch({
          jobId: job.id,
          documentId: job.documentId,
          workspaceId: job.workspaceId,
          revision: job.documentRevision,
          scheduleAt: nextAttemptAt,
        });
        await this.auditService.record({
          workspaceId: job.workspaceId,
          eventType: "document.process",
          eventStatus: "failure",
          metadata: {
            documentId: job.documentId,
            revision: job.documentRevision,
            attemptCount: job.attemptCount,
            retryScheduled: true,
            reason: message,
          },
        });
        await this.emitJobTelemetry("document.worker.job_failed", job, {
          durationMs,
          outcome: "retry_scheduled",
          reason: message,
        });
        return;
      }

      if (job.kind === "enrich") {
        // The document is already queryable; a failed enrich job must never flip
        // it to "failed". Mark only the job failed and leave the document ready.
        await this.jobRepository.markFailed(job.id, message);
      } else {
        const markedFailed = await this.jobRepository.markFailedIfDocumentMatches({
          jobId: job.id,
          documentId: job.documentId,
          workspaceId: job.workspaceId,
          revision: job.documentRevision,
          errorMessage: message,
        });
        if (!markedFailed) {
          const currentDocument = await this.documentRepository.findByIdAndWorkspaceId(job.documentId, job.workspaceId);
          await this.jobRepository.markSkipped(job.id, currentDocument ? "stale_revision" : "document_deleted");
        }
      }
      await this.auditService.record({
        workspaceId: job.workspaceId,
        eventType: "document.process",
        eventStatus: "failure",
        metadata: {
          documentId: job.documentId,
          revision: job.documentRevision,
          attemptCount: job.attemptCount,
          retryScheduled: false,
          permanent: isPermanent,
          reason: message,
        },
      });
      await this.emitJobTelemetry("document.worker.job_failed", job, {
        durationMs,
        outcome: isPermanent ? "failed_permanent" : "failed",
        reason: message,
      });
    });
  }

  private async repairQueueGaps(): Promise<number> {
    const repairedJobCount = await this.jobRepository.backfillMissingQueuedJobs();
    if (repairedJobCount > 0) {
      this.logger.warn(
        {
          role: "worker",
          repairedJobCount,
        },
        "Document processing worker repaired missing queued jobs",
      );
      await this.telemetryService?.emit({
        eventType: "document.worker.queue_repaired",
        severity: "warn",
        metrics: {
          repairedJobCount,
        },
        tags: {
          outcome: "repaired",
        },
      });
    }

    return repairedJobCount;
  }

  private async logQueueState(
    message: string,
    eventType: "document.worker.started" | "document.worker.idle" | "document.worker.processing",
    outcome: "started" | "idle" | "processing",
  ): Promise<void> {
    const snapshot = await this.jobRepository.getQueueSnapshot();
    this.logger.info(
      {
        role: "worker",
        ...this.toLogFields(snapshot),
      },
      message,
    );
    await this.telemetryService?.emit({
      eventType,
      metrics: this.toTelemetryMetrics(snapshot),
      tags: {
        outcome,
      },
    });
  }

  private toLogFields(snapshot: DocumentProcessingQueueSnapshot) {
    return {
      queuedJobCount: snapshot.queuedJobCount,
      processingJobCount: snapshot.processingJobCount,
      oldestQueuedJobAgeMs: snapshot.oldestQueuedJobCreatedAt
        ? Math.max(0, Date.now() - snapshot.oldestQueuedJobCreatedAt.getTime())
        : null,
    };
  }

  private toTelemetryMetrics(snapshot: DocumentProcessingQueueSnapshot): Record<string, number> {
    return {
      queuedJobCount: snapshot.queuedJobCount,
      processingJobCount: snapshot.processingJobCount,
      oldestQueuedJobAgeMs: snapshot.oldestQueuedJobCreatedAt
        ? Math.max(0, Date.now() - snapshot.oldestQueuedJobCreatedAt.getTime())
        : 0,
    };
  }

  private async emitJobTelemetry(
    eventType: "document.worker.job_completed" | "document.worker.job_failed" | "document.worker.job_skipped",
    job: DocumentProcessingJobRecord,
    input: {
      durationMs: number;
      outcome: "completed" | "stale" | "deleted" | "retry_scheduled" | "failed" | "failed_permanent";
      reason?: string;
    },
  ): Promise<void> {
    await this.telemetryService?.emit({
      eventType,
      severity: eventType === "document.worker.job_failed" ? "error" : "info",
      correlation: {
        workspaceId: job.workspaceId,
        jobId: job.id,
        documentId: job.documentId,
      },
      metrics: {
        durationMs: input.durationMs,
        attemptCount: job.attemptCount,
      },
      metadata: input.reason ? { reason: input.reason } : undefined,
      tags: {
        outcome: input.outcome,
      },
    });
  }
}
