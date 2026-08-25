import {
  createNoopWorkspaceInvalidationPublisher,
  type WorkspaceInvalidationPublisher,
} from "@radioso/workspace-invalidation-contract";

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
import type {
  EmbeddingProfileJobService,
  EmbeddingProfileTerminalFailureKind,
  EmbeddingProfileTerminalFailurePort,
} from "./embeddingProfileJobService.js";
import {
  EmbeddingVectorContractError,
  type EmbeddingProfileCleanupService,
} from "../../embeddingProfiles/public.js";

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_JOB_LEASE_MS = 300_000;
const EMBEDDING_CLEANUP_INTERVAL_MS = 60_000;
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
  input: { outcome?: "completed" | "stale" | "deleted" | "superseded" | "retry_scheduled" | "failed" | "failed_permanent" | "processed" | "noop" | "busy" } = {},
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
  private lastEmbeddingCleanupAt = 0;

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
    private readonly embeddingProfileJobService?: Pick<EmbeddingProfileJobService, "process">,
    private readonly embeddingProfileCleanupService?: Pick<EmbeddingProfileCleanupService, "runDue">,
    private readonly postJobMaintenance?: {
      run(input: {
        maxBatches: number;
        workspaceId?: string;
      }): Promise<void>;
    },
    private readonly embeddingProfileTerminalFailures?: EmbeddingProfileTerminalFailurePort,
    private readonly workspaceInvalidationPublisher: WorkspaceInvalidationPublisher =
      createNoopWorkspaceInvalidationPublisher(),
  ) {}

  async runPostJobMaintenance(
    maxBatches = 10,
    workspaceId?: string,
  ): Promise<void> {
    if (!this.postJobMaintenance) {
      return;
    }
    try {
      await this.postJobMaintenance.run({
        maxBatches,
        ...(workspaceId ? { workspaceId } : {}),
      });
    } catch (error) {
      this.logger.error(
        {
          err: error instanceof Error ? error.message : String(error),
          role: "worker",
        },
        "Post-job maintenance failed after document processing",
      );
      await this.errorReporter
        ?.report({
          errorType: "document.worker.post_job_maintenance_failed",
          error,
          severity: "error",
        })
        .catch((reportError) => {
          this.logger.error(
            {
              err: reportError instanceof Error
                ? reportError.message
                : String(reportError),
            },
            "Post-job maintenance error report failed",
          );
        });
    }
  }

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
      if (job.kind !== "vectorize") {
        await this.jobRepository.reschedule(job.id, new Date(), "worker_restarted");
        return;
      }

      if (document.status === "ready") {
        await this.jobRepository.markCompleted(job.id);
        return;
      }

      await this.jobRepository.reschedule(job.id, new Date(), "worker_restarted");
      const resetDocument = await this.documentRepository.setStatusIfRevisionMatches({
        documentId: job.documentId,
        workspaceId: job.workspaceId,
        revision: job.documentRevision,
        status: "queued",
        failureReason: null,
      });
      if (resetDocument) {
        this.publishDocumentStatusChanged(job.workspaceId);
      }
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
    await this.runEmbeddingCleanupIfDue(now);
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
        const outcome = job.kind === "embedding_profile"
          ? await this.requireEmbeddingProfileJobService().process(job)
          : job.kind === "enrich"
            ? await this.processingService.processEnrichment(job)
            : await this.processingService.process(job);
        if (outcome === "completed") {
          await this.jobRepository.markCompleted(job.id);
          await this.runPostJobMaintenance(10, job.workspaceId);
          await this.emitJobTelemetry("document.worker.job_completed", job, {
            durationMs: Date.now() - startedAt,
            outcome: "completed",
          });
        } else {
          const skipReason = outcome === "stale"
            ? "stale_revision"
            : outcome === "superseded"
              ? "profile_superseded"
              : "document_deleted";
          await this.jobRepository.markSkipped(job.id, skipReason);
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
      const isContractInvalid = error instanceof EmbeddingVectorContractError;
      const hasRetriesRemaining =
        !isPermanent
        && !isContractInvalid
        && job.attemptCount < MAX_ATTEMPTS;
      const terminalProfileFailureKind = job.kind === "embedding_profile"
        ? embeddingProfileTerminalFailureKind(error, isPermanent)
        : undefined;

      if (hasRetriesRemaining) {
        const delayMs =
          RETRY_DELAYS_MS[Math.min(job.attemptCount - 1, RETRY_DELAYS_MS.length - 1)] ?? this.pollIntervalMs;
        const nextAttemptAt = new Date(Date.now() + delayMs);
        await this.jobRepository.reschedule(job.id, nextAttemptAt, message);
        // Enrich jobs run against an already-ready document; a retry must never
        // knock it back to "queued" — only the vectorize path owns document status.
        if (job.kind === "vectorize") {
          const requeuedDocument = await this.documentRepository.setStatusIfRevisionMatches({
            documentId: job.documentId,
            workspaceId: job.workspaceId,
            revision: job.documentRevision,
            status: "queued",
            failureReason: null,
          });
          if (requeuedDocument) {
            this.publishDocumentStatusChanged(job.workspaceId);
          }
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
            jobKind: job.kind,
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

      if (job.kind === "embedding_profile") {
        if (!terminalProfileFailureKind) {
          throw new Error(
            "Embedding profile terminal failure classification is unavailable",
          );
        }
        await this.requireEmbeddingProfileTerminalFailures().recordFailure({
          jobId: job.id,
          workspaceId: job.workspaceId,
          embeddingSpaceId: requireEmbeddingProfileJobField(
            job.embeddingSpaceId,
            "embedding space",
          ),
          workspaceProfileGeneration: requireEmbeddingProfileJobField(
            job.workspaceProfileGeneration,
            "workspace profile generation",
          ),
          failureKind: terminalProfileFailureKind,
        });
      }

      if (job.kind !== "vectorize") {
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
        } else {
          this.publishDocumentStatusChanged(job.workspaceId);
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
          jobKind: job.kind,
          retryScheduled: false,
          permanent: isPermanent,
          ...(terminalProfileFailureKind
            ? { embeddingProfileFailureKind: terminalProfileFailureKind }
            : {}),
          reason: message,
        },
      });
      await this.emitJobTelemetry("document.worker.job_failed", job, {
        durationMs,
        outcome: isPermanent ? "failed_permanent" : "failed",
        reason: message,
        embeddingProfileFailureKind: terminalProfileFailureKind,
      });
    });
  }

  private requireEmbeddingProfileJobService(): Pick<EmbeddingProfileJobService, "process"> {
    if (!this.embeddingProfileJobService) {
      throw new Error("Embedding profile job service is not configured");
    }
    return this.embeddingProfileJobService;
  }

  private publishDocumentStatusChanged(workspaceId: string): void {
    this.workspaceInvalidationPublisher.enqueue(workspaceId, ["document.status_changed"]);
  }

  private requireEmbeddingProfileTerminalFailures(): EmbeddingProfileTerminalFailurePort {
    if (!this.embeddingProfileTerminalFailures) {
      throw new Error(
        "Embedding profile terminal failure handling is not configured",
      );
    }
    return this.embeddingProfileTerminalFailures;
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

  private async runEmbeddingCleanupIfDue(now: Date): Promise<void> {
    if (
      !this.embeddingProfileCleanupService
      || now.getTime() - this.lastEmbeddingCleanupAt < EMBEDDING_CLEANUP_INTERVAL_MS
    ) {
      return;
    }
    this.lastEmbeddingCleanupAt = now.getTime();
    try {
      const outcome = await this.embeddingProfileCleanupService.runDue({
        now,
        limit: 25,
      });
      if (outcome.cleaned > 0 || outcome.refused > 0) {
        this.logger.info(
          {
            role: "worker",
            embeddingSpacesCleaned: outcome.cleaned,
            embeddingSpacesCleanupRefused: outcome.refused,
          },
          "Embedding profile cleanup reconciliation completed",
        );
      }
    } catch (error) {
      this.logger.error(
        { error },
        "Embedding profile cleanup reconciliation failed",
      );
    }
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
      outcome: "completed" | "stale" | "deleted" | "superseded" | "retry_scheduled" | "failed" | "failed_permanent";
      reason?: string;
      embeddingProfileFailureKind?: EmbeddingProfileTerminalFailureKind;
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
        ...(input.embeddingProfileFailureKind
          ? {
              jobKind: job.kind,
              embeddingProfileFailureKind: input.embeddingProfileFailureKind,
            }
          : {}),
      },
    });
  }
}

const requireEmbeddingProfileJobField = (
  value: string | null | undefined,
  label: string,
): string => {
  if (!value) {
    throw new Error(`Embedding profile job requires an immutable ${label}`);
  }
  return value;
};

const embeddingProfileTerminalFailureKind = (
  error: unknown,
  isPermanent: boolean,
): EmbeddingProfileTerminalFailureKind => {
  if (error instanceof EmbeddingVectorContractError) {
    return "contract_invalid";
  }
  return isPermanent ? "permanent" : "retry_exhausted";
};
