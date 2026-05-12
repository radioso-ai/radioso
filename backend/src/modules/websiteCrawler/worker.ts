import type { WebsiteCrawlJobRecord, WebsiteCrawlJobRepositoryPort } from "../../db/repositories/websiteCrawlJobRepository.js";
import type { AppLogger } from "../../shared/observability/logger.js";
import type { WebsiteCrawlerProvider } from "./provider.js";
import { WebsiteCrawlerService, type WebsiteCrawlerDocumentIngestionPort, type WebsiteCrawlerAuditPort } from "./service.js";

export class WebsiteCrawlWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  // Tracks the currently in-flight processClaimedJob promise so that stop()
  // can drain it. Without this a SIGTERM during an active crawl leaves the
  // job row in `processing` until the lease window expires (default 15 min),
  // delaying recovery for that crawl.
  private activeJob: Promise<void> | null = null;

  constructor(private readonly dependencies: {
    repository: WebsiteCrawlJobRepositoryPort;
    provider?: WebsiteCrawlerProvider;
    documentIngestionService: WebsiteCrawlerDocumentIngestionPort;
    auditService?: WebsiteCrawlerAuditPort;
    logger: AppLogger;
    pollIntervalMs?: number;
    jobLeaseMs?: number;
  }) {}

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
    if (this.activeJob) {
      try {
        await this.activeJob;
      } catch {
        // processClaimedJob already logs failures and marks the row failed;
        // we just need to wait for it before returning from stop().
      }
    }
  }

  async runOnce(now: Date = new Date()): Promise<boolean> {
    const job = await this.dependencies.repository.claimNext(now);
    if (!job) {
      return false;
    }
    await this.runTracked(() => this.processClaimedJob(job));
    return true;
  }

  async runJobById(jobId: string, now: Date = new Date()): Promise<"processed" | "noop" | "busy"> {
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
    await this.runTracked(() => this.processClaimedJob(claimed));
    return "processed";
  }

  private async runTracked(work: () => Promise<void>): Promise<void> {
    const promise = work();
    this.activeJob = promise.finally(() => {
      if (this.activeJob === promise) {
        this.activeJob = null;
      }
    });
    await promise;
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

  private async processClaimedJob(job: WebsiteCrawlJobRecord): Promise<void> {
    if (!this.dependencies.provider) {
      await this.dependencies.repository.markFailed(job.id, "Website crawler is not configured");
      return;
    }

    try {
      const service = new WebsiteCrawlerService({
        provider: this.dependencies.provider,
        documentIngestionService: this.dependencies.documentIngestionService,
        auditService: this.dependencies.auditService,
      });
      const result = await service.crawlAndPublish({
        accountId: job.accountId,
        workspaceId: job.workspaceId,
        url: job.requestedUrl,
        limit: job.limit,
      });
      await this.dependencies.repository.markCompleted(job.id, result as unknown as Record<string, unknown>);
    } catch (error) {
      await this.dependencies.repository.markFailed(
        job.id,
        error instanceof Error && error.message.trim() ? error.message : "Website crawl failed",
      );
      this.dependencies.logger.error(
        {
          role: "website-crawl-worker",
          jobId: job.id,
          workspaceId: job.workspaceId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Website crawl job failed",
      );
    }
  }
}
