import { describe, expect, it, vi } from "vitest";

import type { WebsiteCrawlJobRecord } from "../../../src/db/repositories/websiteCrawlJobRepository.js";
import { WebsiteCrawlWorker } from "../../../src/modules/websiteCrawler/worker.js";

const createJob = (): WebsiteCrawlJobRecord => ({
  id: "11111111-1111-4111-8111-111111111111",
  accountId: "22222222-2222-4222-8222-222222222222",
  workspaceId: "33333333-3333-4333-8333-333333333333",
  sourceId: null,
  requestedUrl: "https://example.com",
  limit: 2,
  status: "processing",
  attemptCount: 1,
  policy: {
    includeUrlPatterns: [],
    excludeUrlPatterns: [],
    preserveContentLinks: true,
  },
  checkpoint: {
    discoveredUrls: [],
    queuedUrls: [],
    processingUrls: [],
    processedCanonicalUrls: [],
    accepted: 0,
    skipped: 0,
    failed: 0,
    lastProcessedAt: null,
  },
  result: null,
  lastError: null,
  availableAt: new Date(),
  claimedAt: new Date(),
  completedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
});

const waitFor = async (
  predicate: () => boolean,
  timeoutMs = 200,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const createDispatcher = () => ({
  dispatch: vi.fn().mockResolvedValue(undefined),
});

describe("website crawl worker", () => {
  it("claims one crawl job and publishes provider pages through document ingestion", async () => {
    const job = createJob();
    const markCompleted = vi.fn().mockResolvedValue(undefined);
    const ingest = vi.fn().mockResolvedValue({ documentId: "doc-1", status: "queued" });
    const worker = new WebsiteCrawlWorker({
      repository: {
        claimNext: vi.fn().mockResolvedValue(job),
        markCompleted,
        markFailed: vi.fn(),
        updateCheckpoint: vi.fn().mockResolvedValue(undefined),
        releasePausedClaim: vi.fn().mockResolvedValue(undefined),
      } as never,
      provider: {
        name: "test-crawler",
        crawl: vi.fn().mockResolvedValue({
          provider: "test-crawler",
          runId: "run-1",
          pages: [{
            sourceUrl: "https://example.com/a",
            title: "A",
            content: "Alpha",
          }],
        }),
      },
      dispatcher: createDispatcher(),
      documentIngestionService: {
        ingest,
      },
      logger: {
        info: vi.fn(),
        error: vi.fn(),
      } as never,
      pollIntervalMs: 10_000,
    });

    await expect(worker.runOnce()).resolves.toBe(true);

    expect(ingest).toHaveBeenCalledWith(expect.objectContaining({
      accountId: job.accountId,
      workspaceId: job.workspaceId,
      title: "A",
      content: "Alpha",
    }));
    expect(markCompleted).toHaveBeenCalledWith(job.id, job.attemptCount, expect.objectContaining({
      accepted: 1,
      failed: 0,
    }));
  });

  it("carries the persisted source identity into crawl publication", async () => {
    const sourceId = "44444444-4444-4444-8444-444444444444";
    const job = { ...createJob(), sourceId, requestedUrl: "https://example.com/search?apiKey=secret" };
    const ingest = vi.fn().mockResolvedValue({ documentId: "doc-1", status: "queued" });
    const resolveSource = vi.fn().mockImplementation(async ({ source }) => {
      if ("id" in source) {
        return { id: source.id };
      }
      throw new Error("worker re-resolved the source from its URL");
    });
    const worker = new WebsiteCrawlWorker({
      repository: {
        claimNext: vi.fn().mockResolvedValue(job),
        markCompleted: vi.fn().mockResolvedValue(true),
        markFailed: vi.fn().mockResolvedValue(true),
        updateCheckpoint: vi.fn().mockResolvedValue(false),
        releasePausedClaim: vi.fn().mockResolvedValue(false),
      } as never,
      provider: {
        name: "test-crawler",
        crawl: vi.fn().mockResolvedValue({
          provider: "test-crawler",
          runId: "run-1",
          status: "completed",
          pages: [{ sourceUrl: "https://example.com/a", title: "A", content: "Alpha" }],
        }),
      },
      dispatcher: createDispatcher(),
      documentIngestionService: { ingest, resolveSource },
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } as never,
    });

    await expect(worker.runOnce()).resolves.toBe(true);

    expect(resolveSource).toHaveBeenCalledWith({ workspaceId: job.workspaceId, source: { id: sourceId } });
    expect(ingest).toHaveBeenCalledWith(expect.objectContaining({ source: { id: sourceId } }));
  });

  it("publishes completion only after the repository reports an affected row", async () => {
    const job = createJob();
    const publisher = { enqueue: vi.fn() };
    const markCompleted = vi.fn().mockResolvedValue(true);
    const worker = new WebsiteCrawlWorker({
      repository: {
        claimNext: vi.fn().mockResolvedValue(job),
        markCompleted,
        markFailed: vi.fn(),
        updateCheckpoint: vi.fn().mockResolvedValue(false),
        releasePausedClaim: vi.fn().mockResolvedValue(false),
      } as never,
      provider: {
        name: "test-crawler",
        crawl: vi.fn().mockResolvedValue({
          provider: "test-crawler",
          runId: "run-1",
          pages: [],
        }),
      },
      dispatcher: createDispatcher(),
      documentIngestionService: { ingest: vi.fn() },
      publisher,
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } as never,
    });

    await expect(worker.runOnce()).resolves.toBe(true);

    expect(markCompleted).toHaveBeenCalledOnce();
    expect(publisher.enqueue).toHaveBeenCalledTimes(2);
    expect(publisher.enqueue).toHaveBeenNthCalledWith(1, job.workspaceId, ["crawl.status_changed"]);
    expect(publisher.enqueue).toHaveBeenNthCalledWith(2, job.workspaceId, ["crawl.status_changed"]);
  });

  it("publishes checkpoint progress only after a checkpoint was persisted", async () => {
    const job = createJob();
    const publisher = { enqueue: vi.fn() };
    const updateCheckpoint = vi.fn().mockResolvedValueOnce(true);
    const worker = new WebsiteCrawlWorker({
      repository: {
        releaseTimedOutClaimsBatch: vi.fn().mockResolvedValue({ releasedCount: 0, workspaceIds: [], hasMore: false }),
        claimNext: vi.fn().mockResolvedValue(job),
        markCompleted: vi.fn().mockResolvedValue(false),
        markFailed: vi.fn().mockResolvedValue(false),
        updateCheckpoint,
        releasePausedClaim: vi.fn().mockResolvedValue(false),
      } as never,
      provider: {
        name: "test-crawler",
        crawl: vi.fn().mockResolvedValue({
          provider: "test-crawler",
          runId: "run-1",
          pages: [{ sourceUrl: "https://example.com/a", title: "A", content: "Alpha" }],
        }),
      },
      dispatcher: createDispatcher(),
      documentIngestionService: {
        ingest: vi.fn().mockResolvedValue({ documentId: "doc-1", status: "queued" }),
      },
      publisher,
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } as never,
    });

    await expect(worker.runOnce()).resolves.toBe(true);

    expect(updateCheckpoint).toHaveBeenCalledOnce();
    expect(updateCheckpoint).toHaveBeenCalledWith(job.id, job.attemptCount, expect.any(Object));
    expect(publisher.enqueue).toHaveBeenCalledTimes(2);
    expect(publisher.enqueue).toHaveBeenNthCalledWith(1, job.workspaceId, ["crawl.status_changed"]);
    expect(publisher.enqueue).toHaveBeenNthCalledWith(2, job.workspaceId, ["crawl.progress"]);
  });

  it("stays silent for a checkpoint write that lost its claim", async () => {
    const job = createJob();
    const publisher = { enqueue: vi.fn() };
    const updateCheckpoint = vi.fn().mockResolvedValue(false);
    const worker = new WebsiteCrawlWorker({
      repository: {
        releaseTimedOutClaimsBatch: vi.fn().mockResolvedValue({ releasedCount: 0, workspaceIds: [], hasMore: false }),
        claimNext: vi.fn().mockResolvedValue(job),
        markCompleted: vi.fn().mockResolvedValue(false),
        markFailed: vi.fn().mockResolvedValue(false),
        updateCheckpoint,
        releasePausedClaim: vi.fn().mockResolvedValue(false),
      } as never,
      provider: {
        name: "test-crawler",
        crawl: vi.fn().mockResolvedValue({
          provider: "test-crawler",
          runId: "run-1",
          pages: [{ sourceUrl: "https://example.com/a", title: "A", content: "Alpha" }],
        }),
      },
      dispatcher: createDispatcher(),
      documentIngestionService: {
        ingest: vi.fn().mockResolvedValue({ documentId: "doc-1", status: "queued" }),
      },
      publisher,
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } as never,
    });

    await expect(worker.runOnce()).resolves.toBe(true);

    expect(updateCheckpoint).toHaveBeenCalledOnce();
    expect(publisher.enqueue).toHaveBeenCalledTimes(1);
    expect(publisher.enqueue).toHaveBeenCalledWith(job.workspaceId, ["crawl.status_changed"]);
  });

  it("publishes a true failure transition and stays silent when the claim was lost", async () => {
    const job = createJob();
    const publisher = { enqueue: vi.fn() };
    const markFailed = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const provider = {
      name: "test-crawler",
      crawl: vi.fn().mockRejectedValue(new Error("provider unavailable")),
    };
    const repository = {
      claimNext: vi.fn().mockResolvedValue(job),
      markCompleted: vi.fn(),
      markFailed,
      updateCheckpoint: vi.fn().mockResolvedValue(false),
      releasePausedClaim: vi.fn().mockResolvedValue(false),
    };
    const worker = new WebsiteCrawlWorker({
      repository: repository as never,
      provider,
      dispatcher: createDispatcher(),
      documentIngestionService: { ingest: vi.fn() },
      publisher,
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } as never,
    });

    await expect(worker.runOnce()).resolves.toBe(true);
    expect(publisher.enqueue).toHaveBeenCalledTimes(2);
    expect(publisher.enqueue).toHaveBeenCalledWith(job.workspaceId, ["crawl.status_changed"]);
    expect(markFailed).toHaveBeenLastCalledWith(job.id, job.attemptCount, "provider unavailable");

    await expect(worker.runOnce()).resolves.toBe(true);
    expect(publisher.enqueue).toHaveBeenCalledTimes(3);
  });

  it("reports internal crawl faults with correlation and presents safe operator copy", async () => {
    const job = { ...createJob(), sourceId: "source-1" };
    const markFailed = vi.fn().mockResolvedValue(true);
    const report = vi.fn().mockResolvedValue(undefined);
    const internalError = new TypeError("token=crawler-secret at https://crawler.example");
    const worker = new WebsiteCrawlWorker({
      repository: {
        claimNext: vi.fn().mockResolvedValue(job),
        markCompleted: vi.fn(),
        markFailed,
        updateCheckpoint: vi.fn().mockResolvedValue(false),
        releasePausedClaim: vi.fn().mockResolvedValue(false),
      } as never,
      provider: { name: "test-crawler", crawl: vi.fn() },
      dispatcher: createDispatcher(),
      documentIngestionService: {
        ingest: vi.fn(),
        resolveSource: vi.fn().mockRejectedValue(internalError),
      } as never,
      errorReporter: { report },
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } as never,
    });

    await expect(worker.runOnce()).resolves.toBe(true);

    expect(markFailed).toHaveBeenCalledWith(
      job.id,
      job.attemptCount,
      "An internal error interrupted the crawl. Try again later.",
    );
    expect(report).toHaveBeenCalledWith(expect.objectContaining({
      errorType: "website_crawler.worker.internal_fault",
      severity: "error",
      correlation: { workspaceId: job.workspaceId, jobId: job.id },
    }));
    const reportInput = report.mock.calls[0]?.[0];
    expect(reportInput?.error).toMatchObject({
      name: "TypeError",
      message: "Unexpected internal website crawl failure",
    });
    expect(reportInput?.error?.stack).not.toContain("crawler-secret");
    expect(reportInput?.error?.stack).not.toContain("https://crawler.example");
  });

  it("publishes bounded stale recovery once per workspace and immediately requests another tick", async () => {
    const publisher = { enqueue: vi.fn() };
    const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };
    const releaseTimedOutClaimsBatch = vi.fn().mockResolvedValue({
      releasedCount: 3,
      workspaceIds: ["ws-1", "ws-2"],
      hasMore: true,
    });
    const worker = new WebsiteCrawlWorker({
      repository: {
        releaseTimedOutClaimsBatch,
        claimNext: vi.fn().mockResolvedValue(null),
      } as never,
      dispatcher: createDispatcher(),
      documentIngestionService: {} as never,
      publisher,
      logger: logger as never,
      staleClaimRecoveryBatchSize: 25,
    });

    await expect(worker.runOnce(new Date("2026-05-11T10:00:00.000Z"))).resolves.toBe(true);

    expect(releaseTimedOutClaimsBatch).toHaveBeenCalledWith(
      new Date("2026-05-11T09:55:00.000Z"),
      "claim_expired",
      25,
    );
    expect(publisher.enqueue).toHaveBeenCalledTimes(2);
    expect(publisher.enqueue).toHaveBeenCalledWith("ws-1", ["crawl.status_changed"]);
    expect(publisher.enqueue).toHaveBeenCalledWith("ws-2", ["crawl.status_changed"]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ releasedCount: 3, workspaceCount: 2, batchLimit: 25, hasMore: true }),
      "Released stale processing crawl jobs back to queue",
    );
  });

  it("publishes nothing when stale recovery rolls back", async () => {
    const publisher = { enqueue: vi.fn() };
    const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };
    const worker = new WebsiteCrawlWorker({
      repository: {
        releaseTimedOutClaimsBatch: vi.fn().mockRejectedValue(new Error("transaction rolled back")),
        claimNext: vi.fn().mockResolvedValue(null),
      } as never,
      dispatcher: createDispatcher(),
      documentIngestionService: {} as never,
      publisher,
      logger: logger as never,
    });

    await expect(worker.runOnce()).resolves.toBe(false);

    expect(publisher.enqueue).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ error: "transaction rolled back" }),
      "Failed to release stale crawl jobs",
    );
  });

  it("requeues and dispatches a continuation when a crawl slice yields", async () => {
    const job = createJob();
    const publisher = { enqueue: vi.fn() };
    const releaseForContinuation = vi.fn().mockResolvedValue(true);
    const markCompleted = vi.fn().mockResolvedValue(undefined);
    const markFailed = vi.fn().mockResolvedValue(undefined);
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const crawl = vi.fn().mockResolvedValue({
      provider: "test-crawler",
      outcome: "yielded",
      pages: [],
    });
    const worker = new WebsiteCrawlWorker({
      repository: {
        releaseTimedOutClaimsBatch: vi.fn().mockResolvedValue({ releasedCount: 0, workspaceIds: [], hasMore: false }),
        claimNext: vi.fn().mockResolvedValue(job),
        releaseForContinuation,
        markCompleted,
        markFailed,
        updateCheckpoint: vi.fn().mockResolvedValue(undefined),
        releasePausedClaim: vi.fn().mockResolvedValue(undefined),
      } as never,
      provider: { name: "test-crawler", crawl },
      dispatcher: { dispatch },
      documentIngestionService: { ingest: vi.fn() },
      publisher,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      sliceDurationMs: 240_000,
    });

    await expect(worker.runOnce()).resolves.toBe("yielded");

    expect(crawl).toHaveBeenCalledWith(expect.objectContaining({
      maxDurationMs: 240_000,
    }));
    expect(releaseForContinuation).toHaveBeenCalledWith(job.id, job.attemptCount);
    expect(dispatch).toHaveBeenCalledWith({
      jobId: job.id,
      workspaceId: job.workspaceId,
    });
    expect(publisher.enqueue).toHaveBeenCalledTimes(2);
    expect(publisher.enqueue).toHaveBeenNthCalledWith(1, job.workspaceId, ["crawl.status_changed"]);
    expect(publisher.enqueue).toHaveBeenNthCalledWith(2, job.workspaceId, ["crawl.status_changed"]);
    expect(markCompleted).not.toHaveBeenCalled();
    expect(markFailed).not.toHaveBeenCalled();
  });

  it("leaves a yielded job queued and retries delivery when continuation dispatch fails", async () => {
    const job = createJob();
    const releaseForContinuation = vi.fn().mockResolvedValue(true);
    const markFailed = vi.fn().mockResolvedValue(undefined);
    const dispatchError = new Error("queue unavailable");
    const worker = new WebsiteCrawlWorker({
      repository: {
        releaseTimedOutClaimsBatch: vi.fn().mockResolvedValue({ releasedCount: 0, workspaceIds: [], hasMore: false }),
        claimNext: vi.fn().mockResolvedValue(job),
        releaseForContinuation,
        markCompleted: vi.fn(),
        markFailed,
        updateCheckpoint: vi.fn().mockResolvedValue(undefined),
        releasePausedClaim: vi.fn().mockResolvedValue(undefined),
      } as never,
      provider: {
        name: "test-crawler",
        crawl: vi.fn().mockResolvedValue({
          provider: "test-crawler",
          outcome: "yielded",
          pages: [],
        }),
      },
      dispatcher: { dispatch: vi.fn().mockRejectedValue(dispatchError) },
      documentIngestionService: { ingest: vi.fn() },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      sliceDurationMs: 240_000,
    });

    await expect(worker.runOnce()).rejects.toThrow("queue unavailable");

    expect(releaseForContinuation).toHaveBeenCalledWith(job.id, job.attemptCount);
    expect(markFailed).not.toHaveBeenCalled();
  });

  it("does not dispatch continuation when the worker no longer owns the yielded claim", async () => {
    const job = createJob();
    const dispatch = vi.fn();
    const markCompleted = vi.fn();
    const markFailed = vi.fn();
    const worker = new WebsiteCrawlWorker({
      repository: {
        releaseTimedOutClaimsBatch: vi.fn().mockResolvedValue({ releasedCount: 0, workspaceIds: [], hasMore: false }),
        claimNext: vi.fn().mockResolvedValue(job),
        releaseForContinuation: vi.fn().mockResolvedValue(false),
        markCompleted,
        markFailed,
        updateCheckpoint: vi.fn().mockResolvedValue(undefined),
        releasePausedClaim: vi.fn().mockResolvedValue(undefined),
      } as never,
      provider: {
        name: "test-crawler",
        crawl: vi.fn().mockResolvedValue({
          provider: "test-crawler",
          outcome: "yielded",
          pages: [],
        }),
      },
      dispatcher: { dispatch },
      documentIngestionService: { ingest: vi.fn() },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      sliceDurationMs: 240_000,
    });

    await expect(worker.runOnce()).resolves.toBe(true);

    expect(dispatch).not.toHaveBeenCalled();
    expect(markCompleted).not.toHaveBeenCalled();
    expect(markFailed).not.toHaveBeenCalled();
  });

  it("awaits the in-flight crawl when stop() is called mid-job so the row is not left in processing", async () => {
    const job = createJob();
    const markCompleted = vi.fn().mockResolvedValue(undefined);
    const ingest = vi.fn().mockResolvedValue({ documentId: "doc-1", status: "queued" });

    let resolveCrawl!: () => void;
    const crawlComplete = new Promise<void>((resolve) => {
      resolveCrawl = resolve;
    });

    const worker = new WebsiteCrawlWorker({
      repository: {
        claimNext: vi.fn().mockResolvedValue(job),
        markCompleted,
        markFailed: vi.fn(),
        updateCheckpoint: vi.fn().mockResolvedValue(undefined),
        releasePausedClaim: vi.fn().mockResolvedValue(undefined),
      } as never,
      provider: {
        name: "test-crawler",
        crawl: vi.fn().mockImplementation(async () => {
          await crawlComplete;
          return {
            provider: "test-crawler",
            runId: "run-1",
            pages: [{ sourceUrl: "https://example.com/a", title: "A", content: "Alpha" }],
          };
        }),
      },
      dispatcher: createDispatcher(),
      documentIngestionService: { ingest },
      logger: { info: vi.fn(), error: vi.fn() } as never,
      pollIntervalMs: 10_000,
    });

    const inFlight = worker.runOnce();
    // Give the event loop a tick so the worker enters provider.crawl().
    await Promise.resolve();

    // Kick off shutdown while the crawl is still in flight.
    const stopPromise = worker.stop();
    let stopResolved = false;
    void stopPromise.then(() => { stopResolved = true; });

    // The crawl is still pending, so stop() must not have returned yet.
    await Promise.resolve();
    expect(stopResolved).toBe(false);
    expect(markCompleted).not.toHaveBeenCalled();

    // Allow the crawl to finish; stop() should now resolve and the job row
    // should have been marked completed before the runtime exits.
    resolveCrawl();
    await Promise.all([inFlight, stopPromise]);
    expect(markCompleted).toHaveBeenCalledOnce();
    expect(stopResolved).toBe(true);
  });

  it("stop() waits for a job claimed mid-tick so the row is not stranded in processing", async () => {
    const job = createJob();
    const ingest = vi.fn().mockResolvedValue({ documentId: "doc-1", status: "queued" });
    const markCompleted = vi.fn().mockResolvedValue(undefined);

    let resolveClaim!: (value: typeof job | null) => void;
    const claimNext = vi.fn().mockImplementation(() => new Promise((resolve) => {
      resolveClaim = resolve;
    }));

    const worker = new WebsiteCrawlWorker({
      repository: {
        claimNext,
        markCompleted,
        markFailed: vi.fn(),
        updateCheckpoint: vi.fn().mockResolvedValue(undefined),
        releasePausedClaim: vi.fn().mockResolvedValue(undefined),
      } as never,
      provider: {
        name: "test-crawler",
        crawl: vi.fn().mockResolvedValue({
          provider: "test-crawler",
          runId: "run-1",
          pages: [{ sourceUrl: "https://example.com/a", title: "A", content: "Alpha" }],
        }),
      },
      dispatcher: createDispatcher(),
      documentIngestionService: { ingest },
      logger: { info: vi.fn(), error: vi.fn() } as never,
      pollIntervalMs: 10_000,
    });

    // The polling-loop race: a tick is mid-flight in claimNext when stop()
    // arrives. Tracking only the post-claim work would let stop() return
    // before the just-claimed row finishes processing, leaving it in
    // `processing` until the lease expires. Wrapping the full tick in
    // runTracked closes the window — stop() must drain the entire claim +
    // process sequence.
    await worker.start();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(claimNext).toHaveBeenCalledOnce();

    const stopPromise = worker.stop();
    let stopResolved = false;
    void stopPromise.then(() => { stopResolved = true; });

    // Stop must not have resolved yet — the tick is still mid-claim.
    await Promise.resolve();
    expect(stopResolved).toBe(false);

    // Now resolve the claim with a job. Stop must wait for the full
    // claim → process → markCompleted sequence before returning.
    resolveClaim(job);
    await stopPromise;
    expect(stopResolved).toBe(true);
    expect(markCompleted).toHaveBeenCalledOnce();
  });

  it("aborts an in-flight crawl when the claimed job row is deleted", async () => {
    const job = createJob();
    const markCompleted = vi.fn().mockResolvedValue(undefined);
    const markFailed = vi.fn().mockResolvedValue(undefined);
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    let providerStarted = false;
    const repository = {
      releaseTimedOutClaimsBatch: vi.fn().mockResolvedValue({ releasedCount: 0, workspaceIds: [], hasMore: false }),
      claimNext: vi.fn().mockResolvedValue(job),
      findById: vi.fn().mockImplementation(async () => (providerStarted ? null : job)),
      markCompleted,
      markFailed,
      updateCheckpoint: vi.fn().mockResolvedValue(undefined),
      releasePausedClaim: vi.fn().mockResolvedValue(undefined),
    };
    const provider = {
      name: "test-crawler",
      crawl: vi.fn().mockImplementation(({ signal }: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          providerStarted = true;
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
      ),
    };

    const worker = new WebsiteCrawlWorker({
      repository: repository as never,
      provider,
      dispatcher: createDispatcher(),
      documentIngestionService: { ingest: vi.fn() },
      logger: logger as never,
      pollIntervalMs: 10_000,
      cancellationPollMs: 1,
    });

    await expect(worker.runOnce()).resolves.toBe(true);

    await waitFor(() => repository.findById.mock.calls.length >= 1);
    expect(provider.crawl).toHaveBeenCalledWith(expect.objectContaining({
      signal: expect.objectContaining({ aborted: true }),
    }));
    expect(markCompleted).not.toHaveBeenCalled();
    expect(markFailed).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalledWith(
      expect.anything(),
      "Website crawl job failed",
    );
    expect(repository.releasePausedClaim).toHaveBeenCalledWith(job.id, job.attemptCount);
  });

  it("releases a paused claim when a pause wins before completion is observed", async () => {
    const job = createJob();
    const publisher = { enqueue: vi.fn() };
    const releasePausedClaim = vi.fn().mockResolvedValue(true);
    const markCompleted = vi.fn().mockResolvedValue(false);
    const worker = new WebsiteCrawlWorker({
      repository: {
        releaseTimedOutClaimsBatch: vi.fn().mockResolvedValue({ releasedCount: 0, workspaceIds: [], hasMore: false }),
        claimNext: vi.fn().mockResolvedValue(job),
        markCompleted,
        markFailed: vi.fn(),
        updateCheckpoint: vi.fn().mockResolvedValue(undefined),
        releasePausedClaim,
      } as never,
      provider: {
        name: "test-crawler",
        crawl: vi.fn().mockResolvedValue({
          provider: "test-crawler",
          runId: "run-1",
          pages: [{ sourceUrl: "https://example.com/a", title: "A", content: "Alpha" }],
        }),
      },
      dispatcher: createDispatcher(),
      documentIngestionService: {
        ingest: vi.fn().mockResolvedValue({ documentId: "doc-1", status: "queued" }),
      },
      publisher,
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } as never,
      pollIntervalMs: 10_000,
    });

    await expect(worker.runOnce()).resolves.toBe(true);

    expect(markCompleted).toHaveBeenCalledOnce();
    expect(releasePausedClaim).toHaveBeenCalledWith(job.id, job.attemptCount);
    expect(publisher.enqueue).toHaveBeenCalledTimes(2);
    expect(publisher.enqueue).toHaveBeenNthCalledWith(1, job.workspaceId, ["crawl.status_changed"]);
    expect(publisher.enqueue).toHaveBeenNthCalledWith(2, job.workspaceId, ["crawl.status_changed"]);
  });

  it("does not complete a job after cancellation was observed even if the provider resolves", async () => {
    const job = createJob();
    const pausedJob = { ...job, status: "paused" as const };
    const markCompleted = vi.fn().mockResolvedValue(undefined);
    const repository = {
      releaseTimedOutClaimsBatch: vi.fn().mockResolvedValue({ releasedCount: 0, workspaceIds: [], hasMore: false }),
      claimNext: vi.fn().mockResolvedValue(job),
      findById: vi.fn().mockResolvedValue(pausedJob),
      markCompleted,
      markFailed: vi.fn().mockResolvedValue(undefined),
      updateCheckpoint: vi.fn().mockResolvedValue(undefined),
      releasePausedClaim: vi.fn().mockResolvedValue(undefined),
    };
    const provider = {
      name: "test-crawler",
      crawl: vi.fn().mockImplementation(({ signal }: { signal?: AbortSignal }) =>
        new Promise((resolve) => {
          signal?.addEventListener("abort", () => {
            resolve({
              provider: "test-crawler",
              runId: "run-1",
              pages: [{ sourceUrl: "https://example.com/a", title: "A", content: "Alpha" }],
            });
          }, { once: true });
        }),
      ),
    };

    const worker = new WebsiteCrawlWorker({
      repository: repository as never,
      provider,
      dispatcher: createDispatcher(),
      documentIngestionService: {
        ingest: vi.fn().mockResolvedValue({ documentId: "doc-1", status: "queued" }),
      },
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } as never,
      pollIntervalMs: 10_000,
      cancellationPollMs: 1,
    });

    await expect(worker.runOnce()).resolves.toBe(true);

    expect(markCompleted).not.toHaveBeenCalled();
    expect(repository.releasePausedClaim).toHaveBeenCalledWith(job.id, job.attemptCount);
  });

  it("returns busy when another worker owns a fresh claim", async () => {
    const job = {
      ...createJob(),
      status: "processing" as const,
      claimedAt: new Date("2026-05-10T12:00:00.000Z"),
    };
    const repository = {
      findById: vi.fn().mockResolvedValue(job),
      releaseTimedOutClaim: vi.fn().mockResolvedValue(false),
    };
    const worker = new WebsiteCrawlWorker({
      repository: repository as never,
      dispatcher: createDispatcher(),
      documentIngestionService: {} as never,
      logger: {
        info: vi.fn(),
        error: vi.fn(),
      } as never,
      jobLeaseMs: 900_000,
    });

    await expect(worker.runJobById(job.id, new Date("2026-05-10T12:01:00.000Z"))).resolves.toBe("busy");
    expect(repository.releaseTimedOutClaim).toHaveBeenCalledOnce();
  });

  it("publishes stale single-claim release and the following id claim only when both persist", async () => {
    const job = {
      ...createJob(),
      claimedAt: new Date("2026-05-10T11:00:00.000Z"),
    };
    const publisher = { enqueue: vi.fn() };
    const worker = new WebsiteCrawlWorker({
      repository: {
        findById: vi.fn().mockResolvedValue(job),
        releaseTimedOutClaim: vi.fn().mockResolvedValue(true),
        claimById: vi.fn().mockResolvedValue(job),
        updateCheckpoint: vi.fn().mockResolvedValue(false),
        markCompleted: vi.fn().mockResolvedValue(false),
        markFailed: vi.fn().mockResolvedValue(false),
        releasePausedClaim: vi.fn().mockResolvedValue(false),
      } as never,
      provider: {
        name: "test-crawler",
        crawl: vi.fn().mockResolvedValue({ provider: "test-crawler", pages: [] }),
      },
      dispatcher: createDispatcher(),
      documentIngestionService: { ingest: vi.fn() },
      publisher,
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } as never,
      jobLeaseMs: 300_000,
    });

    await expect(worker.runJobById(job.id, new Date("2026-05-10T12:00:00.000Z"))).resolves.toBe("processed");

    expect(publisher.enqueue).toHaveBeenCalledTimes(2);
    expect(publisher.enqueue).toHaveBeenNthCalledWith(1, job.workspaceId, ["crawl.status_changed"]);
    expect(publisher.enqueue).toHaveBeenNthCalledWith(2, job.workspaceId, ["crawl.status_changed"]);
  });

  it("claims with a fresh clock after releasing the final stale batch", async () => {
    const capturedTickAt = new Date("2026-05-11T10:00:00.000Z");
    const job = {
      ...createJob(),
      claimedAt: new Date("2026-05-11T10:00:00.010Z"),
    };
    const claimNext = vi.fn(async (claimAt?: Date) => claimAt === undefined ? job : null);
    const worker = new WebsiteCrawlWorker({
      repository: {
        releaseTimedOutClaimsBatch: vi.fn().mockResolvedValue({
          releasedCount: 1,
          workspaceIds: [job.workspaceId],
          hasMore: false,
        }),
        claimNext,
        markCompleted: vi.fn().mockResolvedValue(true),
        markFailed: vi.fn().mockResolvedValue(false),
        updateCheckpoint: vi.fn().mockResolvedValue(false),
        releasePausedClaim: vi.fn().mockResolvedValue(false),
      } as never,
      provider: {
        name: "test-crawler",
        crawl: vi.fn().mockResolvedValue({ provider: "test-crawler", pages: [] }),
      },
      dispatcher: createDispatcher(),
      documentIngestionService: { ingest: vi.fn() },
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } as never,
    });

    await expect(worker.runOnce(capturedTickAt)).resolves.toBe(true);

    expect(claimNext).toHaveBeenCalledWith();
  });

  it("throttles stale recovery independently from polling", async () => {
    const releaseTimedOutClaimsBatch = vi.fn().mockResolvedValue({
      releasedCount: 0,
      workspaceIds: [],
      hasMore: false,
    });
    const claimNext = vi.fn().mockResolvedValue(null);
    const worker = new WebsiteCrawlWorker({
      repository: { releaseTimedOutClaimsBatch, claimNext } as never,
      dispatcher: createDispatcher(),
      documentIngestionService: {} as never,
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } as never,
      staleClaimRecoveryIntervalMs: 60_000,
    });

    await worker.runOnce(new Date("2026-05-11T10:00:00.000Z"));
    await worker.runOnce(new Date("2026-05-11T10:00:30.000Z"));
    await worker.runOnce(new Date("2026-05-11T10:01:00.000Z"));

    expect(claimNext).toHaveBeenCalledTimes(3);
    expect(releaseTimedOutClaimsBatch).toHaveBeenCalledTimes(2);
  });

  it("continues stale recovery immediately when a batch reports more rows", async () => {
    const releaseTimedOutClaimsBatch = vi.fn()
      .mockResolvedValueOnce({ releasedCount: 25, workspaceIds: ["ws-1"], hasMore: true })
      .mockResolvedValueOnce({ releasedCount: 1, workspaceIds: ["ws-1"], hasMore: false });
    const worker = new WebsiteCrawlWorker({
      repository: {
        releaseTimedOutClaimsBatch,
        claimNext: vi.fn().mockResolvedValue(null),
      } as never,
      dispatcher: createDispatcher(),
      documentIngestionService: {} as never,
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } as never,
      staleClaimRecoveryIntervalMs: 60_000,
    });
    const now = new Date("2026-05-11T10:00:00.000Z");

    await expect(worker.runOnce(now)).resolves.toBe(true);
    await expect(worker.runOnce(now)).resolves.toBe(false);

    expect(releaseTimedOutClaimsBatch).toHaveBeenCalledTimes(2);
  });

  it("drains recovery that is still in flight when stop is requested", async () => {
    let finishRecovery!: () => void;
    const releaseTimedOutClaimsBatch = vi.fn(() => new Promise((resolve) => {
      finishRecovery = () => resolve({ releasedCount: 0, workspaceIds: [], hasMore: false });
    }));
    const worker = new WebsiteCrawlWorker({
      repository: {
        releaseTimedOutClaimsBatch,
        claimNext: vi.fn().mockResolvedValue(null),
      } as never,
      dispatcher: createDispatcher(),
      documentIngestionService: {} as never,
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } as never,
    });

    const tick = worker.runOnce();
    await waitFor(() => releaseTimedOutClaimsBatch.mock.calls.length === 1);
    const stopping = worker.stop();
    let stopped = false;
    void stopping.then(() => { stopped = true; });
    await Promise.resolve();

    expect(stopped).toBe(false);

    finishRecovery();
    await Promise.all([tick, stopping]);
    expect(stopped).toBe(true);
  });

  it("drains every simultaneous public invocation before stop resolves", async () => {
    const firstJob = { ...createJob(), id: "11111111-1111-4111-8111-111111111111", requestedUrl: "https://example.com/first" };
    const secondJob = { ...createJob(), id: "44444444-4444-4444-8444-444444444444", requestedUrl: "https://example.com/second" };
    let finishFirst!: () => void;
    let finishSecond!: () => void;
    const firstCrawl = new Promise<void>((resolve) => { finishFirst = resolve; });
    const secondCrawl = new Promise<void>((resolve) => { finishSecond = resolve; });
    const crawl = vi.fn(async ({ url }: { url: string }) => {
      await (url.endsWith("/first") ? firstCrawl : secondCrawl);
      return { provider: "test-crawler", pages: [] };
    });
    const worker = new WebsiteCrawlWorker({
      repository: {
        releaseTimedOutClaimsBatch: vi.fn().mockResolvedValue({ releasedCount: 0, workspaceIds: [], hasMore: false }),
        claimNext: vi.fn().mockResolvedValueOnce(firstJob).mockResolvedValueOnce(secondJob),
        markCompleted: vi.fn().mockResolvedValue(true),
        markFailed: vi.fn().mockResolvedValue(false),
        updateCheckpoint: vi.fn().mockResolvedValue(false),
        releasePausedClaim: vi.fn().mockResolvedValue(false),
      } as never,
      provider: { name: "test-crawler", crawl },
      dispatcher: createDispatcher(),
      documentIngestionService: { ingest: vi.fn() },
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } as never,
    });

    const firstTick = worker.runOnce(new Date("2026-05-11T10:00:00.000Z"));
    await waitFor(() => crawl.mock.calls.length === 1);
    const secondTick = worker.runOnce(new Date("2026-05-11T10:00:00.001Z"));
    await waitFor(() => crawl.mock.calls.length === 2);
    const stopping = worker.stop();
    let stopped = false;
    void stopping.then(() => { stopped = true; });

    finishSecond();
    await Promise.resolve();
    await Promise.resolve();
    expect(stopped).toBe(false);

    finishFirst();
    await Promise.all([firstTick, secondTick, stopping]);
    expect(stopped).toBe(true);
  });

  it("aborts an old worker when the same job was reclaimed by a newer generation", async () => {
    const oldJob = {
      ...createJob(),
      claimedAt: new Date("2026-05-11T10:00:00.000Z"),
    };
    const reclaimedJob = {
      ...oldJob,
      attemptCount: oldJob.attemptCount + 1,
      claimedAt: new Date("2026-05-11T10:06:00.000Z"),
    };
    const publisher = { enqueue: vi.fn() };
    const markCompleted = vi.fn().mockResolvedValue(false);
    const markFailed = vi.fn().mockResolvedValue(false);
    const releasePausedClaim = vi.fn().mockResolvedValue(false);
    let crawlStarted = false;
    const crawl = vi.fn(({ signal }: { signal?: AbortSignal }) => {
      crawlStarted = true;
      return new Promise<{
        provider: string;
        pages: [];
      }>((resolve) => {
        signal?.addEventListener("abort", () => {
          resolve({ provider: "test-crawler", pages: [] });
        }, { once: true });
        setTimeout(() => resolve({ provider: "test-crawler", pages: [] }), 100).unref?.();
      });
    });
    const worker = new WebsiteCrawlWorker({
      repository: {
        releaseTimedOutClaimsBatch: vi.fn().mockResolvedValue({ releasedCount: 0, workspaceIds: [], hasMore: false }),
        claimNext: vi.fn().mockResolvedValue(oldJob),
        findById: vi.fn(async () => crawlStarted ? reclaimedJob : oldJob),
        markCompleted,
        markFailed,
        updateCheckpoint: vi.fn().mockResolvedValue(false),
        releasePausedClaim,
      } as never,
      provider: { name: "test-crawler", crawl },
      dispatcher: createDispatcher(),
      documentIngestionService: { ingest: vi.fn() },
      publisher,
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } as never,
      cancellationPollMs: 1,
    });

    await expect(worker.runOnce()).resolves.toBe(true);

    expect(crawl).toHaveBeenCalledWith(expect.objectContaining({
      signal: expect.objectContaining({ aborted: true }),
    }));
    expect(markCompleted).not.toHaveBeenCalled();
    expect(markFailed).not.toHaveBeenCalled();
    expect(releasePausedClaim).toHaveBeenCalledWith(oldJob.id, oldJob.attemptCount);
    expect(publisher.enqueue).toHaveBeenCalledTimes(1);
  });
});
