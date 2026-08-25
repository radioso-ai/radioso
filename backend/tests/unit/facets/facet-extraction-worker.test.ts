import { describe, expect, it, vi, type Mock } from "vitest";

import type {
  FacetExtractionJob,
  FacetExtractionJobStore,
  FacetExtractionOutcome,
  FacetExtractionPort,
} from "../../../src/modules/facets/contracts.js";
import {
  FACET_EXTRACTION_MAX_ATTEMPTS,
  FACET_EXTRACTION_RETRY_DELAYS_MS,
  FacetExtractionWorker,
} from "../../../src/modules/facets/services/facetExtractionWorker.js";

const NOW = new Date("2026-08-04T12:00:00.000Z");

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const buildJob = (overrides: Partial<FacetExtractionJob> = {}): FacetExtractionJob => ({
  id: "job-1",
  messageId: "message-1",
  workspaceId: "workspace-1",
  status: "processing",
  attemptCount: 1,
  claimedAt: NOW,
  scheduledAt: NOW,
  lastError: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

type StoreStub = {
  [K in keyof FacetExtractionJobStore]: Mock<FacetExtractionJobStore[K]>;
};

const buildStore = (batches: FacetExtractionJob[][]): StoreStub => {
  const queue = [...batches];
  return {
    enqueue: vi.fn<FacetExtractionJobStore["enqueue"]>(async () => ({ id: "job-1", created: true })),
    claimBatch: vi.fn<FacetExtractionJobStore["claimBatch"]>(async () => queue.shift() ?? []),
    markCompleted: vi.fn<FacetExtractionJobStore["markCompleted"]>(async () => true),
    markSkipped: vi.fn<FacetExtractionJobStore["markSkipped"]>(async () => true),
    markFailed: vi.fn<FacetExtractionJobStore["markFailed"]>(async () => true),
    releaseExpiredClaims: vi.fn<FacetExtractionJobStore["releaseExpiredClaims"]>(async () => 0),
  };
};

const buildPort = (
  extract: (job: FacetExtractionJob) => Promise<FacetExtractionOutcome>,
): FacetExtractionPort & { extract: ReturnType<typeof vi.fn> } => ({
  extract: vi.fn(extract),
});

const buildWorker = (
  jobs: FacetExtractionJobStore,
  extraction: FacetExtractionPort,
  overrides: { pollIntervalMs?: number; batchSize?: number; jobLeaseMs?: number } = {},
) =>
  new FacetExtractionWorker({
    jobs,
    extraction,
    logger: silentLogger,
    pollIntervalMs: overrides.pollIntervalMs ?? 5,
    batchSize: overrides.batchSize ?? 10,
    jobLeaseMs: overrides.jobLeaseMs ?? 300_000,
  });

describe("FacetExtractionWorker", () => {
  it("marks a job completed when extraction succeeds", async () => {
    const store = buildStore([[buildJob()]]);
    const port = buildPort(async () => ({ status: "extracted" }));
    const worker = buildWorker(store, port);

    const processed = await worker.runOnce(NOW);

    expect(processed).toBe(1);
    expect(port.extract).toHaveBeenCalledTimes(1);
    expect(store.markCompleted).toHaveBeenCalledWith(expect.objectContaining({ id: "job-1", attemptCount: 1 }));
    expect(store.markFailed).not.toHaveBeenCalled();
  });

  it("marks a job skipped with the reason the port returned", async () => {
    const store = buildStore([[buildJob()]]);
    const port = buildPort(async () => ({ status: "skipped", reason: "message_deleted" }));
    const worker = buildWorker(store, port);

    await worker.runOnce(NOW);

    expect(store.markSkipped).toHaveBeenCalledWith(
      expect.objectContaining({ id: "job-1", attemptCount: 1 }),
      "message_deleted",
    );
    expect(store.markCompleted).not.toHaveBeenCalled();
  });

  it("reschedules a transient failure using the first backoff delay", async () => {
    const store = buildStore([[buildJob({ attemptCount: 1 })]]);
    const port = buildPort(async () => {
      throw new Error("provider unavailable");
    });
    const worker = buildWorker(store, port);

    await worker.runOnce(NOW);

    expect(store.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ id: "job-1", attemptCount: 1 }),
      "provider unavailable",
      new Date(NOW.getTime() + FACET_EXTRACTION_RETRY_DELAYS_MS[0]!),
    );
  });

  it("uses the next backoff delay on a later attempt", async () => {
    const store = buildStore([[buildJob({ attemptCount: 2 })]]);
    const port = buildPort(async () => {
      throw new Error("provider unavailable");
    });
    const worker = buildWorker(store, port);

    await worker.runOnce(NOW);

    expect(store.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ id: "job-1", attemptCount: 2 }),
      "provider unavailable",
      new Date(NOW.getTime() + FACET_EXTRACTION_RETRY_DELAYS_MS[1]!),
    );
  });

  it("retries a rate-limited provider response (transient 429)", async () => {
    const store = buildStore([[buildJob({ attemptCount: 1 })]]);
    const port = buildPort(async () => {
      throw Object.assign(new Error("rate limited"), { status: 429 });
    });
    const worker = buildWorker(store, port);

    await worker.runOnce(NOW);

    const [, , nextScheduledAt] = store.markFailed.mock.calls[0] as [FacetExtractionJob, string, Date | null];
    expect(nextScheduledAt).toEqual(new Date(NOW.getTime() + FACET_EXTRACTION_RETRY_DELAYS_MS[0]!));
  });

  it("fails a permanent provider rejection immediately without spending the retry budget", async () => {
    const store = buildStore([[buildJob({ attemptCount: 1 })]]);
    const port = buildPort(async () => {
      throw Object.assign(new Error("invalid request"), { status: 400 });
    });
    const worker = buildWorker(store, port);

    await worker.runOnce(NOW);

    expect(store.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ id: "job-1", attemptCount: 1 }),
      "invalid request",
      null,
    );
  });

  it("fails a rejected credential immediately (permanent)", async () => {
    const store = buildStore([[buildJob({ attemptCount: 1 })]]);
    const port = buildPort(async () => {
      throw Object.assign(new Error("bad key"), { status: 401 });
    });
    const worker = buildWorker(store, port);

    await worker.runOnce(NOW);

    const [, , nextScheduledAt] = store.markFailed.mock.calls[0] as [FacetExtractionJob, string, Date | null];
    expect(nextScheduledAt).toBeNull();
  });

  it("fails terminally once the attempt budget is spent", async () => {
    const store = buildStore([[buildJob({ attemptCount: FACET_EXTRACTION_MAX_ATTEMPTS })]]);
    const port = buildPort(async () => {
      throw new Error("still failing");
    });
    const worker = buildWorker(store, port);

    await worker.runOnce(NOW);

    expect(store.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ id: "job-1", attemptCount: FACET_EXTRACTION_MAX_ATTEMPTS }),
      "still failing",
      null,
    );
  });

  it("releases claims older than the lease before claiming a new batch", async () => {
    const store = buildStore([[]]);
    const port = buildPort(async () => ({ status: "extracted" }));
    const worker = buildWorker(store, port, { jobLeaseMs: 60_000 });

    await worker.runOnce(NOW);

    expect(store.releaseExpiredClaims).toHaveBeenCalledWith({
      claimedAtOrBefore: new Date(NOW.getTime() - 60_000),
      maxAttempts: FACET_EXTRACTION_MAX_ATTEMPTS,
    });
    expect(store.claimBatch).toHaveBeenCalledWith(10, NOW);
  });

  it("honors a smaller recovery claim limit than its configured poll-loop batch size", async () => {
    const store = buildStore([[]]);
    const port = buildPort(async () => ({ status: "extracted" }));
    const worker = buildWorker(store, port, { batchSize: 500 });

    await worker.runOnce(NOW, 10);

    expect(store.claimBatch).toHaveBeenCalledWith(10, NOW);
  });

  it("drains the requested workspace through successive batches without claiming another workspace's jobs", async () => {
    const store = buildStore([
      [buildJob({ id: "job-1" }), buildJob({ id: "job-2", messageId: "message-2" })],
      [buildJob({ id: "job-3", messageId: "message-3" })],
    ]);
    const port = buildPort(async () => ({ status: "extracted" }));
    const worker = buildWorker(store, port, { batchSize: 2 });

    const processed = await worker.drainWorkspace({ workspaceId: "workspace-1", maxJobs: 500, now: NOW });

    expect(processed).toBe(3);
    expect(store.releaseExpiredClaims).toHaveBeenCalledWith({
      claimedAtOrBefore: new Date(NOW.getTime() - 300_000),
      maxAttempts: FACET_EXTRACTION_MAX_ATTEMPTS,
      workspaceId: "workspace-1",
    });
    expect(store.claimBatch).toHaveBeenNthCalledWith(1, 2, NOW, "workspace-1");
    expect(store.claimBatch).toHaveBeenNthCalledWith(2, 2, NOW, "workspace-1");
    expect(port.extract).toHaveBeenCalledTimes(3);
  });

  it("keeps processing the rest of the batch when one job throws", async () => {
    const store = buildStore([[buildJob({ id: "job-1" }), buildJob({ id: "job-2", messageId: "message-2" })]]);
    const port = buildPort(async (job) => {
      if (job.id === "job-1") {
        throw new Error("boom");
      }
      return { status: "extracted" };
    });
    const worker = buildWorker(store, port);

    const processed = await worker.runOnce(NOW);

    expect(processed).toBe(2);
    expect(store.markCompleted).toHaveBeenCalledWith(expect.objectContaining({ id: "job-2" }));
  });

  it("survives a tick failure and reports it", async () => {
    const store = buildStore([]);
    store.claimBatch.mockRejectedValueOnce(new Error("db unreachable"));
    const port = buildPort(async () => ({ status: "extracted" }));
    const report = vi.fn().mockResolvedValue(undefined);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const worker = new FacetExtractionWorker({
      jobs: store,
      extraction: port,
      logger,
      pollIntervalMs: 5,
      batchSize: 10,
      errorReporter: { report },
    });

    worker.start();
    await vi.waitFor(() => {
      expect(logger.error).toHaveBeenCalled();
    });
    await worker.stop();

    expect(report).toHaveBeenCalled();
  });

  it("stops cleanly: stop() waits for the in-flight job and no further work is started", async () => {
    const store = buildStore([[buildJob({ id: "job-1" }), buildJob({ id: "job-2", messageId: "message-2" })]]);
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let firstExtractionStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      firstExtractionStarted = resolve;
    });
    const port = buildPort(async () => {
      firstExtractionStarted();
      await gate;
      return { status: "extracted" };
    });
    const worker = buildWorker(store, port);

    worker.start();
    await firstStarted;

    const stopping = worker.stop();
    releaseGate();
    await stopping;

    // The claimed-but-unstarted job is left for the lease reclaim; nothing new is started.
    expect(port.extract).toHaveBeenCalledTimes(1);
    expect(store.markCompleted).toHaveBeenCalledWith(expect.objectContaining({ id: "job-1" }));

    const callsAtStop = port.extract.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(port.extract.mock.calls.length).toBe(callsAtStop);
  });

  it("is idempotent on repeated start/stop", async () => {
    const store = buildStore([]);
    const port = buildPort(async () => ({ status: "extracted" }));
    const worker = buildWorker(store, port);

    worker.start();
    worker.start();
    await worker.stop();
    await worker.stop();

    expect(store.claimBatch.mock.calls.length).toBeLessThanOrEqual(2);
  });
});
