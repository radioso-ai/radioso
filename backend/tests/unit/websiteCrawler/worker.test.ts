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
  result: null,
  lastError: null,
  availableAt: new Date(),
  claimedAt: new Date(),
  completedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
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
