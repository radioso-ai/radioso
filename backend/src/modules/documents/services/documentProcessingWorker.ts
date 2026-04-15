import type { AppLogger } from "../../../shared/observability/logger.js";
import type { AuditService } from "../../audit/services/auditService.js";
import type { DocumentRepositoryPort } from "./documentIngestionService.js";
import type {
  DocumentProcessingJobRecord,
  DocumentProcessingQueueSnapshot,
  DocumentProcessingJobRepositoryPort,
} from "../../../db/repositories/documentProcessingJobRepository.js";
import { DocumentProcessingService } from "./documentProcessingService.js";
import { getProviderFailureReason } from "../../../shared/infra/llm/providerErrors.js";

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [1_000, 5_000, 15_000] as const;

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
    await this.logQueueState("Document processing worker started");
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
    const job = await this.claimNextAvailableJob(now);
    if (!job) {
      if (this.lastActivityState !== "idle") {
        await this.logQueueState("Document processing worker idle");
        this.lastActivityState = "idle";
      }
      return false;
    }

    this.lastActivityState = "processing";
    await this.logQueueState("Document processing worker processing");

    try {
      const outcome = await this.processingService.process(job);
      if (outcome === "completed") {
        await this.jobRepository.markCompleted(job.id);
      } else {
        await this.jobRepository.markSkipped(job.id, outcome === "stale" ? "stale_revision" : "document_deleted");
      }
    } catch (error) {
      await this.handleFailure(job, error);
    }

    return true;
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
        this.scheduleNextTick(this.pollIntervalMs);
      }
    }, delayMs);
  }

  private async handleFailure(job: DocumentProcessingJobRecord, error: unknown): Promise<void> {
    const message = getProviderFailureReason(error);
    const hasRetriesRemaining = job.attemptCount < MAX_ATTEMPTS;

    if (hasRetriesRemaining) {
      const delayMs = RETRY_DELAYS_MS[Math.min(job.attemptCount - 1, RETRY_DELAYS_MS.length - 1)] ?? this.pollIntervalMs;
      await this.jobRepository.reschedule(job.id, new Date(Date.now() + delayMs), message);
      await this.documentRepository.setStatusIfRevisionMatches({
        documentId: job.documentId,
        workspaceId: job.workspaceId,
        revision: job.documentRevision,
        status: "queued",
        failureReason: null,
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
      return;
    }

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
    await this.auditService.record({
      workspaceId: job.workspaceId,
      eventType: "document.process",
      eventStatus: "failure",
      metadata: {
        documentId: job.documentId,
        revision: job.documentRevision,
        attemptCount: job.attemptCount,
        retryScheduled: false,
        reason: message,
      },
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
    }

    return repairedJobCount;
  }

  private async logQueueState(message: string): Promise<void> {
    const snapshot = await this.jobRepository.getQueueSnapshot();
    this.logger.info(
      {
        role: "worker",
        ...this.toLogFields(snapshot),
      },
      message,
    );
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
}
