import { describe, expect, it, vi } from "vitest";

import { DocumentProcessingWorker } from "../../src/modules/documents/services/documentProcessingWorker.js";
import { InMemoryDocumentProcessingJobRepository, InMemoryDocumentRepository } from "../support/fakes.js";

// Lease length used across these scenarios: long enough that "now" never
// accidentally looks stale on its own, short enough that advancing the clock
// by a few multiples of it clearly crosses the cutoff.
const JOB_LEASE_MS = 300_000;
const MAX_ATTEMPTS = 3;

const justAfterLease = (claimedAt: Date) => new Date(claimedAt.getTime() + JOB_LEASE_MS + 1);

/**
 * Drives a job through MAX_ATTEMPTS claim-and-abandon cycles purely at the
 * repository layer — exactly how production behaves when the push worker's
 * request is killed by the platform's request timeout before the job ever
 * calls back in: the claim is real, but nothing about the worker's own
 * recovery logic has run yet. Returns the timestamp of the final claim, so
 * the caller can assert on the worker's behavior once that last lease has
 * also expired.
 */
const exhaustAttemptsAtRepositoryLayer = async (
  jobRepository: InMemoryDocumentProcessingJobRepository,
  jobId: string,
  startAt: Date,
): Promise<Date> => {
  let claimedAt = startAt;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const claimed = await jobRepository.claimById(jobId, claimedAt);
    expect(claimed?.attemptCount).toBe(attempt);
    if (attempt < MAX_ATTEMPTS) {
      const released = await jobRepository.releaseOrFailExpiredClaim({
        jobId,
        claimedAtOrBefore: justAfterLease(claimedAt),
        maxAttempts: MAX_ATTEMPTS,
        releasedReason: "claim_expired",
        exhaustedReason: "claim_expired_attempts_exhausted",
      });
      expect(released?.status).toBe("queued");
      claimedAt = justAfterLease(claimedAt);
    }
  }
  return claimedAt;
};

const baseDocumentFields = {
  sourceKind: "inline_text" as const,
  sourceFilename: null,
  sourceMimeType: "text/plain",
  sourceStorageBucket: null,
  sourceStorageObject: null,
  sourceStorageGeneration: null,
  sourceSizeBytes: null,
};

describe("DocumentProcessingWorker claim-expiry attempt exhaustion", () => {
  it("fails a vectorize job and the document once a run that never returns has been attempted three times", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const jobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
    documentRepository.setJobRepository(jobRepository);
    const document = await documentRepository.create({
      ...baseDocumentFields,
      workspaceId: "workspace-1",
      title: "Too large to finish in one request",
      sourceContent: "content",
      markdownContent: "content",
      status: "processing",
    });
    const job = await jobRepository.enqueue({
      documentId: document.id,
      workspaceId: document.workspaceId,
      documentRevision: document.revision,
    });

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const telemetryService = { emit: vi.fn().mockResolvedValue(null) };
    const auditService = { record: vi.fn().mockResolvedValue(undefined) };
    const publisher = { enqueue: vi.fn() };
    const worker = new DocumentProcessingWorker(
      documentRepository,
      jobRepository,
      { process: vi.fn() } as never,
      auditService as never,
      logger as never,
      10_000,
      undefined,
      JOB_LEASE_MS,
      telemetryService as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      publisher,
    );

    const lastClaimedAt = await exhaustAttemptsAtRepositoryLayer(jobRepository, job.id, new Date());

    await expect(worker.runOnce(justAfterLease(lastClaimedAt))).resolves.toBe(false);

    const finalJob = jobRepository.items.get(job.id);
    expect(finalJob).toMatchObject({
      status: "failed",
      lastError: "claim_expired_attempts_exhausted",
      attemptCount: 3,
    });

    const finalDocument = documentRepository.items.get(document.id);
    expect(finalDocument).toMatchObject({
      status: "failed",
      failureReason: "claim_expired_attempts_exhausted",
    });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "worker",
        jobId: job.id,
        jobKind: "vectorize",
        documentId: document.id,
        attemptCount: 3,
      }),
      expect.stringContaining("claim expired"),
    );
    expect(telemetryService.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "document.worker.claim_expired_attempts_exhausted",
        tags: { jobKind: "vectorize" },
      }),
    );
    expect(telemetryService.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "document.worker.job_failed",
        tags: { outcome: "failed" },
      }),
    );
    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "document.process",
        eventStatus: "failure",
        metadata: expect.objectContaining({
          retryScheduled: false,
          reason: "claim_expired_attempts_exhausted",
        }),
      }),
    );
    expect(publisher.enqueue).toHaveBeenCalledWith("workspace-1", ["document.status_changed"]);

    // The job never gets reclaimed again.
    await expect(jobRepository.claimNext(new Date(justAfterLease(lastClaimedAt).getTime() + 1_000))).resolves.toBeNull();
  });

  it("leaves an already-published document untouched when its enrich job's claim is exhausted", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const jobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
    documentRepository.setJobRepository(jobRepository);
    const document = await documentRepository.create({
      ...baseDocumentFields,
      workspaceId: "workspace-1",
      title: "Already serving retrieval",
      sourceContent: "content",
      markdownContent: "content",
      status: "ready",
    });
    const job = await jobRepository.enqueue({
      documentId: document.id,
      workspaceId: document.workspaceId,
      documentRevision: document.revision,
      kind: "enrich",
    });

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const auditService = { record: vi.fn().mockResolvedValue(undefined) };
    const publisher = { enqueue: vi.fn() };
    const worker = new DocumentProcessingWorker(
      documentRepository,
      jobRepository,
      { process: vi.fn() } as never,
      auditService as never,
      logger as never,
      10_000,
      undefined,
      JOB_LEASE_MS,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      publisher,
    );

    const lastClaimedAt = await exhaustAttemptsAtRepositoryLayer(jobRepository, job.id, new Date());
    await expect(worker.runOnce(justAfterLease(lastClaimedAt))).resolves.toBe(false);

    expect(jobRepository.items.get(job.id)).toMatchObject({
      status: "failed",
      lastError: "claim_expired_attempts_exhausted",
    });
    // The already-published document is never hidden from retrieval: only the
    // job fails, exactly as a normal exhausted-retry enrich failure behaves.
    expect(documentRepository.items.get(document.id)).toMatchObject({
      status: "ready",
    });
    expect(publisher.enqueue).not.toHaveBeenCalled();
  });

  it("records a retry-exhausted embedding-profile terminal failure without touching the document", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const jobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
    documentRepository.setJobRepository(jobRepository);
    const document = await documentRepository.create({
      ...baseDocumentFields,
      workspaceId: "workspace-1",
      title: "Embedding-only profile backfill",
      sourceContent: "content",
      markdownContent: "content",
      status: "ready",
    });
    const job = await jobRepository.enqueue({
      documentId: document.id,
      workspaceId: document.workspaceId,
      documentRevision: document.revision,
      kind: "embedding_profile",
    });
    jobRepository.items.set(job.id, {
      ...jobRepository.items.get(job.id)!,
      embeddingSpaceId: "space-1",
      workspaceProfileGeneration: "gen-1",
    });

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const auditService = { record: vi.fn().mockResolvedValue(undefined) };
    const embeddingProfileTerminalFailures = { recordFailure: vi.fn().mockResolvedValue(undefined) };
    const worker = new DocumentProcessingWorker(
      documentRepository,
      jobRepository,
      { process: vi.fn() } as never,
      auditService as never,
      logger as never,
      10_000,
      undefined,
      JOB_LEASE_MS,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      embeddingProfileTerminalFailures as never,
    );

    const lastClaimedAt = await exhaustAttemptsAtRepositoryLayer(jobRepository, job.id, new Date());
    await expect(worker.runOnce(justAfterLease(lastClaimedAt))).resolves.toBe(false);

    expect(embeddingProfileTerminalFailures.recordFailure).toHaveBeenCalledWith({
      jobId: job.id,
      workspaceId: "workspace-1",
      embeddingSpaceId: "space-1",
      workspaceProfileGeneration: "gen-1",
      failureKind: "retry_exhausted",
    });
    expect(jobRepository.items.get(job.id)).toMatchObject({ status: "failed" });
    expect(documentRepository.items.get(document.id)).toMatchObject({ status: "ready" });
  });

  it("fails a job through the push-worker recovery route (runJobById) the same way as the sweep", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const jobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
    documentRepository.setJobRepository(jobRepository);
    const document = await documentRepository.create({
      ...baseDocumentFields,
      workspaceId: "workspace-1",
      title: "Recovered via push-worker retry",
      sourceContent: "content",
      markdownContent: "content",
      status: "processing",
    });
    const job = await jobRepository.enqueue({
      documentId: document.id,
      workspaceId: document.workspaceId,
      documentRevision: document.revision,
    });

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const auditService = { record: vi.fn().mockResolvedValue(undefined) };
    const worker = new DocumentProcessingWorker(
      documentRepository,
      jobRepository,
      { process: vi.fn() } as never,
      auditService as never,
      logger as never,
      10_000,
      undefined,
      JOB_LEASE_MS,
    );

    const lastClaimedAt = await exhaustAttemptsAtRepositoryLayer(jobRepository, job.id, new Date());

    await expect(worker.runJobById(job.id, justAfterLease(lastClaimedAt))).resolves.toBe("noop");

    expect(jobRepository.items.get(job.id)).toMatchObject({
      status: "failed",
      lastError: "claim_expired_attempts_exhausted",
    });
    expect(documentRepository.items.get(document.id)).toMatchObject({ status: "failed" });
  });

  it("still releases (not fails) an expired claim with attempts remaining", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const jobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
    documentRepository.setJobRepository(jobRepository);
    const document = await documentRepository.create({
      ...baseDocumentFields,
      workspaceId: "workspace-1",
      title: "First attempt only",
      sourceContent: "content",
      markdownContent: "content",
      status: "processing",
    });
    const job = await jobRepository.enqueue({
      documentId: document.id,
      workspaceId: document.workspaceId,
      documentRevision: document.revision,
    });

    const claimedAt = new Date();
    await jobRepository.claimById(job.id, claimedAt);

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const telemetryService = { emit: vi.fn().mockResolvedValue(null) };
    const worker = new DocumentProcessingWorker(
      documentRepository,
      jobRepository,
      { process: vi.fn().mockResolvedValue("completed") } as never,
      { record: vi.fn().mockResolvedValue(undefined) } as never,
      logger as never,
      10_000,
      undefined,
      JOB_LEASE_MS,
      telemetryService as never,
    );

    await expect(worker.runOnce(justAfterLease(claimedAt))).resolves.toBe(true);

    // Released and immediately reclaimed by the same tick, then completed —
    // not failed, and no exhaustion telemetry was emitted.
    expect(jobRepository.items.get(job.id)).toMatchObject({ status: "completed" });
    expect(telemetryService.emit).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "document.worker.claim_expired_attempts_exhausted" }),
    );
  });
});
