import {
  createNoopWorkspaceInvalidationPublisher,
  type WorkspaceInvalidationKind,
  type WorkspaceInvalidationPublisher,
} from "@radioso/workspace-invalidation-contract";

import {
  DEFAULT_STALE_CLAIM_RECOVERY_BATCH_SIZE,
  type WebsiteCrawlJobRecord,
  type WebsiteCrawlJobRepositoryPort,
} from "../../db/repositories/websiteCrawlJobRepository.js";
import type { AppLogger } from "../../shared/observability/logger.js";
import type { WebsiteCrawlerProvider } from "./provider.js";
import type { WebsiteCrawlJobDispatcherPort } from "./jobDispatcher.js";
import { WebsiteCrawlerService, type WebsiteCrawlerDocumentIngestionPort, type WebsiteCrawlerAuditPort } from "./service.js";

export class WebsiteCrawlWorker {
  private static readonly DEFAULT_SLICE_DURATION_MS = 120_000;
  private static readonly DEFAULT_STALE_CLAIM_RECOVERY_INTERVAL_MS = 60_000;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  // Tracks the currently in-flight tick (claim + process) so that stop() can
  // drain it. Wrapping the entire tick — not just processClaimedJob — closes
  // the race where SIGTERM lands between claimNext returning and processing
  // starting; without that, the just-claimed row would be stranded in
  // `processing` until the lease window expires (default 5 min).
  private readonly activeInvocations = new Set<Promise<unknown>>();
  private staleClaimRecovery: Promise<boolean> | null = null;
  private nextStaleClaimRecoveryAtMs = Number.NEGATIVE_INFINITY;
  private readonly publisher: WorkspaceInvalidationPublisher;

  constructor(private readonly dependencies: {
    repository: WebsiteCrawlJobRepositoryPort;
    provider?: WebsiteCrawlerProvider;
    dispatcher: WebsiteCrawlJobDispatcherPort;
    documentIngestionService: WebsiteCrawlerDocumentIngestionPort;
    auditService?: WebsiteCrawlerAuditPort;
    logger: AppLogger;
    pollIntervalMs?: number;
    jobLeaseMs?: number;
    cancellationPollMs?: number;
    sliceDurationMs?: number;
    staleClaimRecoveryBatchSize?: number;
    staleClaimRecoveryIntervalMs?: number;
    publisher?: WorkspaceInvalidationPublisher;
  }) {
    this.publisher = dependencies.publisher ?? createNoopWorkspaceInvalidationPublisher();
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    this.dependencies.logger.info({ role: "website-crawl-worker" }, "Website crawl worker starting");
    this.scheduleNextTick(0);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    while (this.activeInvocations.size > 0) {
      await Promise.allSettled([...this.activeInvocations]);
    }
  }

  async runOnce(now: Date = new Date()): Promise<boolean | "yielded"> {
    // The whole claim+process tick is tracked so stop() can await it. Tracking
    // only the process half would leave a window where claimNext just returned
    // a job but processing has not yet started — stop() would not see anything
    // to drain, return immediately, and the just-claimed row would be stranded
    // in `processing` for the full lease window.
    return this.runTracked(async () => {
      const recoveryHasMore = await this.releaseStaleJobs(now);
      // Batch recovery stamps available_at from the database clock. Claim with
      // that same clock source instead of the tick's earlier app timestamp, or
      // the final recovered batch can be invisible until a later invocation.
      const job = await this.dependencies.repository.claimNext();
      if (!job) {
        return recoveryHasMore;
      }
      this.publish(job.workspaceId, "crawl.status_changed");
      return (await this.processClaimedJob(job)) ?? true;
    });
  }

  async runJobById(jobId: string, now: Date = new Date()): Promise<"processed" | "noop" | "busy"> {
    return this.runTracked(async () => {
      const existing = await this.dependencies.repository.findById(jobId);
      if (!existing) {
        return "noop";
      }
      if (existing.status === "completed" || existing.status === "failed") {
        return "noop";
      }
      if (existing.status === "processing") {
        const claimedBefore = new Date(now.getTime() - (this.dependencies.jobLeaseMs ?? 300_000));
        const released = await this.dependencies.repository.releaseTimedOutClaim(jobId, claimedBefore, "claim_expired");
        if (!released) {
          return "busy";
        }
        this.publish(existing.workspaceId, "crawl.status_changed");
      }
      const claimed = await this.dependencies.repository.claimById(jobId, now);
      if (!claimed) {
        const current = await this.dependencies.repository.findById(jobId);
        if (
          current?.status === "processing"
          && current.claimedAt
          && current.claimedAt.getTime() > now.getTime() - (this.dependencies.jobLeaseMs ?? 300_000)
        ) {
          return "busy";
        }
        return "noop";
      }
      this.publish(claimed.workspaceId, "crawl.status_changed");
      await this.processClaimedJob(claimed);
      return "processed";
    });
  }

  private async runTracked<T>(work: () => Promise<T>): Promise<T> {
    const promise = work();
    this.activeInvocations.add(promise);
    try {
      return await promise;
    } finally {
      this.activeInvocations.delete(promise);
    }
  }

  private scheduleNextTick(delayMs = this.dependencies.pollIntervalMs ?? 5_000): void {
    if (!this.running) {
      return;
    }
    this.timer = setTimeout(async () => {
      try {
        const processed = await this.runOnce();
        this.scheduleNextTick(processed ? 0 : this.dependencies.pollIntervalMs ?? 5_000);
      } catch (error) {
        this.dependencies.logger.error(
          { role: "website-crawl-worker", error: error instanceof Error ? error.message : String(error) },
          "Website crawl worker tick failed",
        );
        this.scheduleNextTick();
      }
    }, delayMs);
  }

  private async releaseStaleJobs(now: Date): Promise<boolean> {
    if (this.staleClaimRecovery) {
      return this.staleClaimRecovery;
    }
    if (now.getTime() < this.nextStaleClaimRecoveryAtMs) {
      return false;
    }
    const intervalMs = Math.max(
      0,
      this.dependencies.staleClaimRecoveryIntervalMs
        ?? WebsiteCrawlWorker.DEFAULT_STALE_CLAIM_RECOVERY_INTERVAL_MS,
    );
    this.nextStaleClaimRecoveryAtMs = now.getTime() + intervalMs;
    const recovery = this.performStaleJobRecovery(now);
    this.staleClaimRecovery = recovery;
    try {
      const hasMore = await recovery;
      if (hasMore) {
        this.nextStaleClaimRecoveryAtMs = Number.NEGATIVE_INFINITY;
      }
      return hasMore;
    } finally {
      if (this.staleClaimRecovery === recovery) {
        this.staleClaimRecovery = null;
      }
    }
  }

  private async performStaleJobRecovery(now: Date): Promise<boolean> {
    try {
      const leaseMs = this.dependencies.jobLeaseMs ?? 300_000;
      const cutoff = new Date(now.getTime() - leaseMs);
      const batchLimit = this.dependencies.staleClaimRecoveryBatchSize
        ?? DEFAULT_STALE_CLAIM_RECOVERY_BATCH_SIZE;
      const released = await this.dependencies.repository.releaseTimedOutClaimsBatch(
        cutoff,
        "claim_expired",
        batchLimit,
      );
      for (const workspaceId of released.workspaceIds) {
        this.publish(workspaceId, "crawl.status_changed");
      }
      if (released.releasedCount > 0) {
        this.dependencies.logger.warn(
          {
            role: "website-crawl-worker",
            releasedCount: released.releasedCount,
            workspaceCount: released.workspaceIds.length,
            batchLimit,
            hasMore: released.hasMore,
          },
          "Released stale processing crawl jobs back to queue",
        );
      }
      return released.hasMore;
    } catch (error) {
      this.dependencies.logger.error(
        { role: "website-crawl-worker", error: error instanceof Error ? error.message : String(error) },
        "Failed to release stale crawl jobs",
      );
      return false;
    }
  }

  private async processClaimedJob(job: WebsiteCrawlJobRecord): Promise<"yielded" | void> {
    if (!this.dependencies.provider) {
      if (await this.dependencies.repository.markFailed(
        job.id,
        job.attemptCount,
        "Website crawler is not configured",
      )) {
        this.publish(job.workspaceId, "crawl.status_changed");
      }
      return;
    }

    const abortController = new AbortController();
    let cancelled = false;
    const cancellationMonitor = this.startCancellationMonitor(job, () => {
      cancelled = true;
      abortController.abort();
    });
    let releasedForContinuation = false;

    try {
      const service = new WebsiteCrawlerService({
        provider: this.dependencies.provider,
        documentIngestionService: this.dependencies.documentIngestionService,
        auditService: this.dependencies.auditService,
        logger: this.dependencies.logger,
      });
      const result = await service.crawlAndPublish({
        accountId: job.accountId,
        workspaceId: job.workspaceId,
        sourceId: job.sourceId,
        url: job.requestedUrl,
        limit: job.limit,
        maxDurationMs: this.dependencies.sliceDurationMs ?? WebsiteCrawlWorker.DEFAULT_SLICE_DURATION_MS,
        signal: abortController.signal,
        policy: job.policy,
        checkpoint: job.checkpoint,
        onCheckpoint: async (checkpoint) => {
          if (await this.dependencies.repository.updateCheckpoint(job.id, job.attemptCount, checkpoint)) {
            this.publish(job.workspaceId, "crawl.progress");
          }
        },
      });
      clearInterval(cancellationMonitor);
      if (cancelled) {
        return;
      }
      if (result.outcome === "yielded") {
        releasedForContinuation = await this.dependencies.repository.releaseForContinuation(
          job.id,
          job.attemptCount,
        );
        if (!releasedForContinuation) {
          return;
        }
        this.publish(job.workspaceId, "crawl.status_changed");
        this.dependencies.logger.info(
          {
            role: "website-crawl-worker",
            jobId: job.id,
            workspaceId: job.workspaceId,
            attemptCount: job.attemptCount,
          },
          "Website crawl slice yielded; dispatching continuation",
        );
        await this.dependencies.dispatcher.dispatch({
          jobId: job.id,
          workspaceId: job.workspaceId,
        });
        return "yielded";
      }
      if (await this.dependencies.repository.markCompleted(
        job.id,
        job.attemptCount,
        result as unknown as Record<string, unknown>,
      )) {
        this.publish(job.workspaceId, "crawl.status_changed");
      }
    } catch (error) {
      if (releasedForContinuation) {
        this.dependencies.logger.error(
          {
            role: "website-crawl-worker",
            jobId: job.id,
            workspaceId: job.workspaceId,
            error: error instanceof Error ? error.message : String(error),
          },
          "Website crawl continuation dispatch failed",
        );
        throw error;
      }
      if (cancelled) {
        return;
      }
      const failed = await this.dependencies.repository.markFailed(
        job.id,
        job.attemptCount,
        error instanceof Error && error.message.trim() ? error.message : "Website crawl failed",
      );
      if (failed) {
        this.publish(job.workspaceId, "crawl.status_changed");
      }
      this.dependencies.logger.error(
        {
          role: "website-crawl-worker",
          jobId: job.id,
          workspaceId: job.workspaceId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Website crawl job failed",
      );
    } finally {
      clearInterval(cancellationMonitor);
      await this.releasePausedClaim(job.id, job.attemptCount, job.workspaceId);
    }
  }

  private async releasePausedClaim(
    jobId: string,
    expectedAttemptCount: number,
    workspaceId: string,
  ): Promise<void> {
    try {
      if (await this.dependencies.repository.releasePausedClaim(jobId, expectedAttemptCount)) {
        this.publish(workspaceId, "crawl.status_changed");
      }
    } catch (error) {
      this.dependencies.logger.warn(
        { role: "website-crawl-worker", jobId, error: error instanceof Error ? error.message : String(error) },
        "Failed to release paused crawl job claim",
      );
    }
  }

  private publish(workspaceId: string, changeKind: WorkspaceInvalidationKind): void {
    this.publisher.enqueue(workspaceId, [changeKind]);
  }

  private startCancellationMonitor(
    job: WebsiteCrawlJobRecord,
    cancel: () => void,
  ): NodeJS.Timeout {
    const timer = setInterval(async () => {
      try {
        const current = await this.dependencies.repository.findById(job.id);
        if (
          !current
          || current.workspaceId !== job.workspaceId
          || current.status !== "processing"
          || !current.claimedAt
          || current.attemptCount !== job.attemptCount
        ) {
          cancel();
        }
      } catch (error) {
        this.dependencies.logger.warn(
          { role: "website-crawl-worker", jobId: job.id, error: error instanceof Error ? error.message : String(error) },
          "Failed to check website crawl job cancellation state",
        );
      }
    }, this.dependencies.cancellationPollMs ?? 1_000);
    timer.unref?.();
    return timer;
  }
}
