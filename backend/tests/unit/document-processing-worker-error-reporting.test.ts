import { afterEach, describe, expect, it, vi } from "vitest";

import { DocumentProcessingWorker } from "../../src/modules/documents/services/documentProcessingWorker.js";
import type { DocumentProcessingJobRecord } from "../../src/db/repositories/documentProcessingJobRepository.js";

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

  it("marks a job completed when enrichment fails open inside document processing", async () => {
    const job: DocumentProcessingJobRecord = {
      id: "33cc6be4-1a3a-4b43-9714-e87e9f9a60ab",
      documentId: "77d89bb2-b69a-43b0-b226-62f40d160321",
      workspaceId: "e93ea86d-28ec-4d2f-aa9a-5e633a22c6df",
      documentRevision: 2,
      status: "processing",
      attemptCount: 1,
      lastError: null,
      availableAt: new Date("2026-07-02T00:00:00.000Z"),
      claimedAt: new Date("2026-07-02T00:00:00.000Z"),
      completedAt: null,
      createdAt: new Date("2026-07-02T00:00:00.000Z"),
      updatedAt: new Date("2026-07-02T00:00:00.000Z"),
      options: { documentEnrichmentOverride: "on" },
    };
    const jobRepository = {
      listProcessingJobs: vi.fn().mockResolvedValue([]),
      backfillMissingQueuedJobs: vi.fn().mockResolvedValue(0),
      getQueueSnapshot: vi.fn().mockResolvedValue(queueSnapshot),
      claimNext: vi.fn().mockResolvedValue(job),
      markCompleted: vi.fn().mockResolvedValue(undefined),
      markSkipped: vi.fn().mockResolvedValue(undefined),
      markFailedIfDocumentMatches: vi.fn().mockResolvedValue(true),
      reschedule: vi.fn().mockResolvedValue(undefined),
      releaseTimedOutClaim: vi.fn().mockResolvedValue(false),
    };
    const processingService = {
      process: vi.fn().mockResolvedValue("completed"),
    };
    const auditService = { record: vi.fn().mockResolvedValue(undefined) };
    const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };

    const worker = new DocumentProcessingWorker(
      {} as never,
      jobRepository as never,
      processingService as never,
      auditService as never,
      logger as never,
    );

    await expect(worker.runOnce()).resolves.toBe(true);

    expect(processingService.process).toHaveBeenCalledWith(job);
    expect(jobRepository.markCompleted).toHaveBeenCalledWith(job.id);
    expect(jobRepository.markFailedIfDocumentMatches).not.toHaveBeenCalled();
    expect(jobRepository.reschedule).not.toHaveBeenCalled();
    expect(auditService.record).not.toHaveBeenCalledWith(expect.objectContaining({
      eventStatus: "failure",
    }));
  });
});
