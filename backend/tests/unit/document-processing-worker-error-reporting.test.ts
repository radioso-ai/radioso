import { afterEach, describe, expect, it, vi } from "vitest";

import { DocumentProcessingWorker } from "../../src/modules/documents/services/documentProcessingWorker.js";

const queueSnapshot = { queuedJobCount: 0, processingJobCount: 0, oldestQueuedJobCreatedAt: null };

describe("DocumentProcessingWorker tick error reporting", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports an unexpected poll-tick failure to the error reporter", async () => {
    vi.useFakeTimers();

    const tickError = new Error("db down");
    const jobRepository = {
      listProcessingJobs: vi.fn().mockResolvedValue([]),
      backfillMissingQueuedJobs: vi.fn().mockResolvedValue(0),
      getQueueSnapshot: vi.fn().mockResolvedValue(queueSnapshot),
      claimNext: vi.fn().mockRejectedValue(tickError),
    };
    const report = vi.fn().mockResolvedValue(undefined);
    const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };

    const worker = new DocumentProcessingWorker(
      {} as never,
      jobRepository as never,
      {} as never,
      {} as never,
      logger as never,
      10, // small poll interval
      undefined, // jobDispatcher → default noop
      undefined, // jobLeaseMs → default
      undefined, // telemetryService
      { report }, // errorReporter
    );

    await worker.start();
    await vi.advanceTimersByTimeAsync(15);
    await worker.stop();

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ error: tickError }),
      "Document processing worker tick failed",
    );
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        errorType: "document.worker.tick_failed",
        error: tickError,
        severity: "error",
      }),
    );
  });
});
