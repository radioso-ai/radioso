import { describe, expect, it, vi } from "vitest";

import { DocumentProcessingWorker } from "../../../src/modules/documents/services/documentProcessingWorker.js";
import { EmbeddingVectorContractError } from "../../../src/modules/embeddingProfiles/public.js";
import {
  createAuditService,
  InMemoryDocumentProcessingJobRepository,
  InMemoryDocumentRepository,
} from "../../support/fakes.js";

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe("embedding profile worker routing", () => {
  it("routes pinned profile work without invoking normal document processing", async () => {
    const documents = new InMemoryDocumentRepository();
    const jobs = new InMemoryDocumentProcessingJobRepository(documents);
    const document = await documents.create({
      workspaceId: "workspace-1",
      title: "Ready",
      sourceContent: "content",
      markdownContent: "content",
      status: "ready",
      sourceKind: "inline_text",
      sourceFilename: null,
      sourceMimeType: "text/plain",
      sourceStorageBucket: null,
      sourceStorageObject: null,
      sourceStorageGeneration: null,
      sourceSizeBytes: null,
    });
    const job = await jobs.enqueue({
      documentId: document.id,
      workspaceId: document.workspaceId,
      documentRevision: document.revision,
    });
    jobs.items.set(job.id, {
      ...job,
      kind: "embedding_profile",
      embeddingSpaceId: "space-pending",
      workspaceProfileGeneration: "2",
    });
    const process = vi.fn();
    const processProfile = vi.fn().mockResolvedValue("completed");
    const runMaintenance = vi.fn().mockResolvedValue(undefined);
    const worker = new DocumentProcessingWorker(
      documents,
      jobs,
      { process } as never,
      createAuditService(),
      logger as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { process: processProfile } as never,
      undefined,
      { run: runMaintenance } as never,
    );

    await expect(worker.runOnce()).resolves.toBe(true);

    expect(processProfile).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }));
    expect(process).not.toHaveBeenCalled();
    expect(jobs.items.get(job.id)?.status).toBe("completed");
    expect(runMaintenance).toHaveBeenCalledWith({
      maxBatches: 10,
      workspaceId: "workspace-1",
    });
    expect((await documents.findByIdAndWorkspaceId(document.id, document.workspaceId))?.status).toBe("ready");
  });

  it("retries failed profile work without mutating a ready document", async () => {
    const documents = new InMemoryDocumentRepository();
    const jobs = new InMemoryDocumentProcessingJobRepository(documents);
    const document = await documents.create({
      workspaceId: "workspace-1",
      title: "Ready",
      sourceContent: "content",
      markdownContent: "content",
      status: "ready",
      sourceKind: "inline_text",
      sourceFilename: null,
      sourceMimeType: "text/plain",
      sourceStorageBucket: null,
      sourceStorageObject: null,
      sourceStorageGeneration: null,
      sourceSizeBytes: null,
    });
    const job = await jobs.enqueue({
      documentId: document.id,
      workspaceId: document.workspaceId,
      documentRevision: document.revision,
    });
    jobs.items.set(job.id, {
      ...job,
      kind: "embedding_profile",
      embeddingSpaceId: "space-pending",
      workspaceProfileGeneration: "2",
    });
    const worker = new DocumentProcessingWorker(
      documents,
      jobs,
      { process: vi.fn() } as never,
      createAuditService(),
      logger as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { process: vi.fn().mockRejectedValue(new Error("temporary")) } as never,
      undefined,
      undefined,
      { recordFailure: vi.fn() },
    );

    await expect(worker.runOnce()).resolves.toBe(true);

    expect(jobs.items.get(job.id)?.status).toBe("queued");
    expect((await documents.findByIdAndWorkspaceId(document.id, document.workspaceId))?.status).toBe("ready");
  });

  it("blocks the pinned transition before failing retry-exhausted profile work", async () => {
    const documents = new InMemoryDocumentRepository();
    const jobs = new InMemoryDocumentProcessingJobRepository(documents);
    const document = await documents.create({
      workspaceId: "workspace-1",
      title: "Ready",
      sourceContent: "content",
      markdownContent: "content",
      status: "ready",
      sourceKind: "inline_text",
      sourceFilename: null,
      sourceMimeType: "text/plain",
      sourceStorageBucket: null,
      sourceStorageObject: null,
      sourceStorageGeneration: null,
      sourceSizeBytes: null,
    });
    const queued = await jobs.enqueue({
      documentId: document.id,
      workspaceId: document.workspaceId,
      documentRevision: document.revision,
    });
    jobs.items.set(queued.id, {
      ...queued,
      kind: "embedding_profile",
      embeddingSpaceId: "space-pending",
      workspaceProfileGeneration: "2",
      attemptCount: 2,
    });
    const markFailed = vi.spyOn(jobs, "markFailed");
    const recordFailure = vi.fn().mockResolvedValue(undefined);
    const audit = createAuditService();
    const emit = vi.fn().mockResolvedValue(undefined);
    const worker = new DocumentProcessingWorker(
      documents,
      jobs,
      { process: vi.fn() } as never,
      audit,
      logger as never,
      undefined,
      undefined,
      undefined,
      { emit } as never,
      undefined,
      { process: vi.fn().mockRejectedValue(new Error("provider unavailable")) } as never,
      undefined,
      undefined,
      { recordFailure },
    );

    await expect(worker.runOnce()).resolves.toBe(true);

    expect(recordFailure).toHaveBeenCalledWith({
      jobId: queued.id,
      workspaceId: "workspace-1",
      embeddingSpaceId: "space-pending",
      workspaceProfileGeneration: "2",
      failureKind: "retry_exhausted",
    });
    expect(recordFailure.mock.invocationCallOrder[0]).toBeLessThan(
      markFailed.mock.invocationCallOrder[0],
    );
    expect(jobs.items.get(queued.id)).toMatchObject({
      status: "failed",
      lastError: "provider unavailable",
    });
    expect(audit.events.at(-1)?.metadata).toMatchObject({
      jobKind: "embedding_profile",
      embeddingProfileFailureKind: "retry_exhausted",
      retryScheduled: false,
    });
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "document.worker.job_failed",
      tags: expect.objectContaining({
        jobKind: "embedding_profile",
        embeddingProfileFailureKind: "retry_exhausted",
      }),
    }));
  });

  it("quarantines a contract-invalid transition without retrying the profile job", async () => {
    const documents = new InMemoryDocumentRepository();
    const jobs = new InMemoryDocumentProcessingJobRepository(documents);
    const document = await documents.create({
      workspaceId: "workspace-1",
      title: "Ready",
      sourceContent: "content",
      markdownContent: "content",
      status: "ready",
      sourceKind: "inline_text",
      sourceFilename: null,
      sourceMimeType: "text/plain",
      sourceStorageBucket: null,
      sourceStorageObject: null,
      sourceStorageGeneration: null,
      sourceSizeBytes: null,
    });
    const queued = await jobs.enqueue({
      documentId: document.id,
      workspaceId: document.workspaceId,
      documentRevision: document.revision,
    });
    jobs.items.set(queued.id, {
      ...queued,
      kind: "embedding_profile",
      embeddingSpaceId: "space-pending",
      workspaceProfileGeneration: "2",
    });
    const recordFailure = vi.fn().mockResolvedValue(undefined);
    const worker = new DocumentProcessingWorker(
      documents,
      jobs,
      { process: vi.fn() } as never,
      createAuditService(),
      logger as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        process: vi.fn().mockRejectedValue(
          new EmbeddingVectorContractError("wrong dimensions"),
        ),
      } as never,
      undefined,
      undefined,
      { recordFailure },
    );

    await expect(worker.runOnce()).resolves.toBe(true);

    expect(recordFailure).toHaveBeenCalledWith(expect.objectContaining({
      failureKind: "contract_invalid",
    }));
    expect(jobs.items.get(queued.id)?.status).toBe("failed");
  });

  it("leaves terminal profile work recoverable when transition failure recording fails", async () => {
    const documents = new InMemoryDocumentRepository();
    const jobs = new InMemoryDocumentProcessingJobRepository(documents);
    const document = await documents.create({
      workspaceId: "workspace-1",
      title: "Ready",
      sourceContent: "content",
      markdownContent: "content",
      status: "ready",
      sourceKind: "inline_text",
      sourceFilename: null,
      sourceMimeType: "text/plain",
      sourceStorageBucket: null,
      sourceStorageObject: null,
      sourceStorageGeneration: null,
      sourceSizeBytes: null,
    });
    const queued = await jobs.enqueue({
      documentId: document.id,
      workspaceId: document.workspaceId,
      documentRevision: document.revision,
    });
    jobs.items.set(queued.id, {
      ...queued,
      kind: "embedding_profile",
      embeddingSpaceId: "space-pending",
      workspaceProfileGeneration: "2",
      attemptCount: 2,
    });
    const markFailed = vi.spyOn(jobs, "markFailed");
    const worker = new DocumentProcessingWorker(
      documents,
      jobs,
      { process: vi.fn() } as never,
      createAuditService(),
      logger as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { process: vi.fn().mockRejectedValue(new Error("provider unavailable")) } as never,
      undefined,
      undefined,
      {
        recordFailure: vi.fn().mockRejectedValue(
          new Error("transition store unavailable"),
        ),
      },
    );

    await expect(worker.runOnce()).rejects.toThrow(
      "transition store unavailable",
    );
    expect(markFailed).not.toHaveBeenCalled();
    expect(jobs.items.get(queued.id)?.status).toBe("processing");
  });

  it("releases an in-flight profile job on restart even when the document is ready", async () => {
    const documents = new InMemoryDocumentRepository();
    const jobs = new InMemoryDocumentProcessingJobRepository(documents);
    const document = await documents.create({
      workspaceId: "workspace-1",
      title: "Ready",
      sourceContent: "content",
      markdownContent: "content",
      status: "ready",
      sourceKind: "inline_text",
      sourceFilename: null,
      sourceMimeType: "text/plain",
      sourceStorageBucket: null,
      sourceStorageObject: null,
      sourceStorageGeneration: null,
      sourceSizeBytes: null,
    });
    const queued = await jobs.enqueue({
      documentId: document.id,
      workspaceId: document.workspaceId,
      documentRevision: document.revision,
    });
    jobs.items.set(queued.id, {
      ...queued,
      kind: "embedding_profile",
      embeddingSpaceId: "space-pending",
      workspaceProfileGeneration: "2",
    });
    await jobs.claimById(queued.id);
    const worker = new DocumentProcessingWorker(
      documents,
      jobs,
      { process: vi.fn() } as never,
      createAuditService(),
      logger as never,
      10_000,
      undefined,
      undefined,
      undefined,
      undefined,
      { process: vi.fn() } as never,
    );

    await worker.start();
    await worker.stop();

    expect(jobs.items.get(queued.id)).toEqual(expect.objectContaining({
      status: "queued",
      lastError: "worker_restarted",
    }));
    expect((await documents.findByIdAndWorkspaceId(document.id, document.workspaceId))?.status).toBe("ready");
  });
});
