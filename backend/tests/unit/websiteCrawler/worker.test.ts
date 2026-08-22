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
      } as never,
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
    expect(markCompleted).toHaveBeenCalledWith(job.id, expect.objectContaining({
      accepted: 1,
      failed: 0,
    }));
  });

  it("requeues and dispatches a continuation when a crawl slice yields", async () => {
    const job = createJob();
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
        releaseAllTimedOutClaims: vi.fn().mockResolvedValue(0),
        claimNext: vi.fn().mockResolvedValue(job),
        releaseForContinuation,
        markCompleted,
        markFailed,
        updateCheckpoint: vi.fn().mockResolvedValue(undefined),
        releasePausedClaim: vi.fn().mockResolvedValue(undefined),
      } as never,
      provider: { name: "test-crawler", crawl },
      dispatcher: { dispatch },
      documentIngestionService: { ingest: vi.fn() } as never,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      sliceDurationMs: 240_000,
    });

    await expect(worker.runOnce()).resolves.toBe("yielded");

    expect(crawl).toHaveBeenCalledWith(expect.objectContaining({
      maxDurationMs: 240_000,
    }));
    expect(releaseForContinuation).toHaveBeenCalledWith(job.id, job.claimedAt);
    expect(dispatch).toHaveBeenCalledWith({
      jobId: job.id,
      workspaceId: job.workspaceId,
    });
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
        releaseAllTimedOutClaims: vi.fn().mockResolvedValue(0),
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
      documentIngestionService: { ingest: vi.fn() } as never,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      sliceDurationMs: 240_000,
    });

    await expect(worker.runOnce()).rejects.toThrow("queue unavailable");

    expect(releaseForContinuation).toHaveBeenCalledWith(job.id, job.claimedAt);
    expect(markFailed).not.toHaveBeenCalled();
  });

  it("does not dispatch continuation when the worker no longer owns the yielded claim", async () => {
    const job = createJob();
    const dispatch = vi.fn();
    const markCompleted = vi.fn();
    const markFailed = vi.fn();
    const worker = new WebsiteCrawlWorker({
      repository: {
        releaseAllTimedOutClaims: vi.fn().mockResolvedValue(0),
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
      documentIngestionService: { ingest: vi.fn() } as never,
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
      documentIngestionService: { ingest } as never,
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
      documentIngestionService: { ingest } as never,
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
      releaseAllTimedOutClaims: vi.fn().mockResolvedValue([]),
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
      documentIngestionService: { ingest: vi.fn() } as never,
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
    expect(repository.releasePausedClaim).toHaveBeenCalledWith(job.id);
  });

  it("releases a paused claim when a pause wins before completion is observed", async () => {
    const job = createJob();
    const releasePausedClaim = vi.fn().mockResolvedValue(undefined);
    const markCompleted = vi.fn().mockResolvedValue(undefined);
    const worker = new WebsiteCrawlWorker({
      repository: {
        releaseAllTimedOutClaims: vi.fn().mockResolvedValue([]),
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
      } as never,
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } as never,
      pollIntervalMs: 10_000,
    });

    await expect(worker.runOnce()).resolves.toBe(true);

    expect(markCompleted).toHaveBeenCalledOnce();
    expect(releasePausedClaim).toHaveBeenCalledWith(job.id);
  });

  it("does not complete a job after cancellation was observed even if the provider resolves", async () => {
    const job = createJob();
    const pausedJob = { ...job, status: "paused" as const };
    const markCompleted = vi.fn().mockResolvedValue(undefined);
    const repository = {
      releaseAllTimedOutClaims: vi.fn().mockResolvedValue([]),
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
      } as never,
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } as never,
      pollIntervalMs: 10_000,
      cancellationPollMs: 1,
    });

    await expect(worker.runOnce()).resolves.toBe(true);

    expect(markCompleted).not.toHaveBeenCalled();
    expect(repository.releasePausedClaim).toHaveBeenCalledWith(job.id);
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
});
